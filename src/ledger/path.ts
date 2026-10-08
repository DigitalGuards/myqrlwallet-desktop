/**
 * BIP-32 paths for the QRL v2.0 Ledger app.
 *
 * The app accepts exactly `m/44'/238'/account'/change/index` with a hardened
 * account and a non-hardened change and index (`is_valid_zond_bip32_path` in
 * the app). It derives the secp256k1 private key at that path and uses it as
 * the ML-DSA-87 key generation seed, so these accounts restore only on a
 * Ledger running the same app.
 */
import { LedgerError } from './errors';

const HARDENED = 0x80000000;
const PURPOSE = 44;
const COIN_TYPE = 238;
const SEGMENT = /^(0|[1-9]\d*)(')?$/;

function invalid(path: string): LedgerError {
  return new LedgerError(
    'invalid-path',
    `Unsupported derivation path ${JSON.stringify(path)}; expected m/44'/238'/account'/change/index`,
  );
}

/** Parse and validate a path into its five BIP-32 levels (hardened bit included). */
export function parseQrlPath(path: string): number[] {
  const parts = path.split('/');
  if (parts.length !== 6 || parts[0] !== 'm') throw invalid(path);
  const levels: number[] = [];
  for (const part of parts.slice(1)) {
    const match = SEGMENT.exec(part);
    if (!match) throw invalid(path);
    const value = Number(match[1]);
    if (!Number.isSafeInteger(value) || value >= HARDENED) throw invalid(path);
    levels.push(match[2] ? value + HARDENED : value);
  }
  const [purpose, coin, account, change, index] = levels;
  if (
    purpose !== HARDENED + PURPOSE ||
    coin !== HARDENED + COIN_TYPE ||
    account === undefined ||
    account < HARDENED ||
    change === undefined ||
    change >= HARDENED ||
    index === undefined ||
    index >= HARDENED
  ) {
    throw invalid(path);
  }
  return levels;
}

/** Wire form: level count followed by each level as a big-endian uint32. */
export function encodeQrlPath(path: string): Uint8Array {
  const levels = parseQrlPath(path);
  const out = new Uint8Array(1 + levels.length * 4);
  const view = new DataView(out.buffer);
  out[0] = levels.length;
  levels.forEach((level, i) => view.setUint32(1 + i * 4, level));
  return out;
}

/** The path of address `index` in account `account` (change 0). */
export function qrlAccountPath(index: number, account = 0): string {
  const path = `m/${PURPOSE}'/${COIN_TYPE}'/${account}'/0/${index}`;
  parseQrlPath(path);
  return path;
}
