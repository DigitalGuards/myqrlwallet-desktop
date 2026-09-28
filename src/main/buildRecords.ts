/**
 * What MAIN knows about a transaction it assembled, kept so the trusted confirm
 * window can say where the transaction's gas limit came from.
 *
 * The renderer hands `REQUEST_SIGNATURE` a complete unsigned transaction. Main
 * validates its shape and binds it to the unlocked account and the live chain
 * id, and it also built that transaction a moment earlier in
 * `BUILD_TRANSACTION`. Remembering the estimate from that build lets the confirm
 * dialog distinguish "this gas limit is my own estimate" from "a dApp asked for
 * this much, and my estimate was lower", and say so.
 *
 * A miss is safe and expected: it means main has no build of its own to compare
 * against (a stale request, a long-delayed approval, or a renderer that
 * assembled the fee fields itself), and the dialog says exactly that.
 *
 * Bounded FIFO plus a TTL, in the shape of `ipc.ts`'s signed-tx-hash cache, so
 * a long session cannot grow it without limit and a record cannot outlive the
 * approval it belongs to.
 */
import type { UnsignedTransaction } from '../shared/schemas';

export interface GasBuildRecord {
  /** The gas limit main's own `qrl_estimateGas` + buffer produced, decimal. */
  estimatedGas: string;
  /** The dApp-requested gas limit that came with the build, when there was one. */
  requestedGas?: string;
}

/** Keep at most this many recent builds. */
const BUILD_RECORD_LIMIT = 32;
/** Drop a record this long after the build, in ms. */
export const BUILD_RECORD_TTL_MS = 10 * 60 * 1000;

interface StoredRecord extends GasBuildRecord {
  at: number;
}

const records = new Map<string, StoredRecord>();

/**
 * Stable key for an unsigned transaction: every field that is signed, in a
 * fixed order. Two builds that differ anywhere the signer would notice get
 * different keys, so a record can never be read against a different
 * transaction than the one it was created for.
 */
export function buildFingerprint(tx: UnsignedTransaction): string {
  return [
    tx.from.toLowerCase(),
    tx.to.toLowerCase(),
    tx.value,
    String(tx.nonce),
    tx.gas,
    tx.maxFeePerGas,
    tx.maxPriorityFeePerGas,
    String(tx.chainId),
    tx.type,
    tx.data ?? '',
  ].join('|');
}

function prune(now: number): void {
  for (const [key, record] of records) {
    if (now - record.at >= BUILD_RECORD_TTL_MS) records.delete(key);
  }
  while (records.size > BUILD_RECORD_LIMIT) {
    const oldest = records.keys().next().value;
    if (oldest === undefined) break;
    records.delete(oldest);
  }
}

/** Record what main's own estimate was for a transaction it just built. */
export function rememberBuild(
  tx: UnsignedTransaction,
  record: GasBuildRecord,
  now: number = Date.now(),
): void {
  const key = buildFingerprint(tx);
  // Re-set so the entry moves to the back of the FIFO on a rebuild.
  records.delete(key);
  records.set(key, { ...record, at: now });
  prune(now);
}

/** The build record for this exact transaction, when main still holds one. */
export function recallBuild(
  tx: UnsignedTransaction,
  now: number = Date.now(),
): GasBuildRecord | undefined {
  prune(now);
  const found = records.get(buildFingerprint(tx));
  if (!found) return undefined;
  const { estimatedGas, requestedGas } = found;
  return requestedGas === undefined ? { estimatedGas } : { estimatedGas, requestedGas };
}

/** Test seam: forget every record. */
export function clearBuildRecords(): void {
  records.clear();
}
