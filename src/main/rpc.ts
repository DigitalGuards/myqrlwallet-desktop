/**
 * Minimal JSON-RPC client + transaction assembly. This is the seed of the
 * "bundled local RPC proxy" the desktop app becomes (Stage 3 of the research
 * roadmap): today it talks to the configured QRL v3 `qrl_*` endpoints (by
 * default the wallet backend's RPC proxies, see config.ts), reads failing
 * over to the secondary and broadcast failing over on transport errors only.
 * Signing stays separate (in the signer); broadcast is `sendRawTransaction`
 * here.
 *
 * No secrets pass through this module.
 */
import { EXPECTED_CHAIN_ID, EXPECTED_GENESIS_HASH, RPC_URL, RPC_URL_SECONDARY } from './config';
import type { BuildTransactionRequest, FeeLevel, UnsignedTransaction } from '../shared/schemas';
import { rememberBuild } from './buildRecords';

interface JsonRpcResponse<T> {
  jsonrpc: '2.0';
  id: number;
  result?: T;
  error?: { code: number; message: string };
}

/**
 * A TRANSPORT failure (endpoint unreachable, reset, timeout, gateway error):
 * the request never got a JSON-RPC answer, so nothing was accepted or
 * rejected by a node. Distinguished from JSON-RPC errors because only
 * transport failures are safe to fail over on for a broadcast.
 */
export class RpcTransportError extends Error {}

export class RpcIdentityError extends Error {}

/** Pull a usable detail (ECONNRESET, ETIMEDOUT, ...) out of undici's opaque
 * "TypeError: fetch failed" wrapper so the surfaced error names the problem. */
function transportDetail(err: unknown): string {
  if (!(err instanceof Error)) return 'network error';
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'timeout';
  const cause = err.cause;
  if (cause && typeof cause === 'object' && 'code' in cause) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return err.message || 'network error';
}

let rpcId = 0;

async function rpcCallOn<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const host = new URL(url).host;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
      // The signer, not main, never makes RPC calls; this is main's proxy.
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new RpcTransportError(`rpc ${method}: ${host} unreachable (${transportDetail(err)})`, {
      cause: err,
    });
  }
  // A non-2xx here is a gateway/proxy-level failure (JSON-RPC rejections come
  // back as 200 + error body), so it counts as transport too.
  if (!res.ok) throw new RpcTransportError(`rpc ${method}: ${host} http ${res.status}`);
  let body: JsonRpcResponse<T>;
  try {
    body = (await res.json()) as JsonRpcResponse<T>;
  } catch {
    // A 200 whose body is not JSON is a gateway/interstitial (a Cloudflare
    // challenge or error page on the CF-fronted proxy), NOT a node answer:
    // classify it as transport so reads fail over and a broadcast retries the
    // secondary instead of surfacing a raw "Unexpected token '<'" to the user.
    throw new RpcTransportError(`rpc ${method}: ${host} returned a non-JSON body`);
  }
  // A genuine JSON-RPC error means a node ANSWERED and refused: surface it (a
  // broadcast must NOT fail over on it).
  if (body.error) throw new Error(`rpc ${method}: ${body.error.message}`);
  // 200 with neither result nor error is a malformed envelope (proxy noise),
  // not a node answer: treat as transport so it fails over like a non-JSON body.
  if (body.result === undefined) {
    throw new RpcTransportError(`rpc ${method}: ${host} returned no result`);
  }
  return body.result;
}

/** Verify each endpoint before using its account data or sending a signed transaction. */
async function assertEndpointIdentity(url: string): Promise<void> {
  const [chainId, genesis] = await Promise.all([
    rpcCallOn<unknown>(url, 'qrl_chainId', []),
    rpcCallOn<{ hash?: unknown } | null>(url, 'qrl_getBlockByNumber', ['0x0', false]),
  ]);
  if (
    typeof chainId !== 'string' ||
    !/^0x[0-9a-f]+$/i.test(chainId) ||
    BigInt(chainId) !== BigInt(EXPECTED_CHAIN_ID) ||
    typeof genesis?.hash !== 'string' ||
    genesis.hash.toLowerCase() !== EXPECTED_GENESIS_HASH
  ) {
    throw new RpcIdentityError(`rpc endpoint ${new URL(url).host} does not match this v3 network`);
  }
}

/** Read-only call with independently qualified primary and secondary endpoints. */
async function rpcRead<T>(method: string, params: unknown[]): Promise<T> {
  try {
    await assertEndpointIdentity(RPC_URL);
    return await rpcCallOn<T>(RPC_URL, method, params);
  } catch (primaryErr) {
    if (RPC_URL_SECONDARY && RPC_URL_SECONDARY !== RPC_URL) {
      try {
        await assertEndpointIdentity(RPC_URL_SECONDARY);
        return await rpcCallOn<T>(RPC_URL_SECONDARY, method, params);
      } catch {
        /* fall through to throw the primary error */
      }
    }
    throw primaryErr;
  }
}

const hexToBigInt = (h: string): bigint => BigInt(h);

/**
 * Read the chain id from the node. Deliberately NO silent fallback: the chain
 * id is a signature-binding, replay-safety value, so an unreachable node must
 * fail the build/sign loudly rather than bind transactions to a guessed chain.
 */
export async function getChainId(): Promise<number> {
  const chainId = Number(hexToBigInt(await rpcRead<string>('qrl_chainId', [])));
  if (chainId !== EXPECTED_CHAIN_ID) throw new RpcIdentityError('rpc chain identity changed');
  return chainId;
}

export async function getBalance(address: string): Promise<string> {
  const hex = await rpcRead<string>('qrl_getBalance', [address, 'latest']);
  return hexToBigInt(hex).toString(10);
}

async function getTransactionCount(address: string): Promise<number> {
  const hex = await rpcRead<string>('qrl_getTransactionCount', [address, 'pending']);
  return Number(hexToBigInt(hex));
}

async function getGasPrice(): Promise<bigint> {
  try {
    return hexToBigInt(await rpcRead<string>('qrl_gasPrice', []));
  } catch {
    return 1_000_000_000n; // 1 gwei fallback, matches the web wallet default
  }
}

/** An EIP-1559 fee pair for one transaction. */
export interface FeeQuote {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/** Multipliers on the node's suggested tip (percent), matching the web wallet. */
const TIP_MULTIPLIERS: Record<FeeLevel, bigint> = { low: 100n, medium: 150n, high: 200n };

/**
 * Fee-market pricing, the web wallet's `quoteFees` policy: the tip scales the
 * node's suggestion (`qrl_maxPriorityFeePerGas`), and maxFee = 2 * baseFee +
 * tip leaves headroom for several base-fee rises before the transaction
 * could stall. Only base fee + tip is charged; the node refunds the rest.
 */
export function marketFees(suggestedTip: bigint, baseFeePerGas: bigint, level: FeeLevel): FeeQuote {
  const maxPriorityFeePerGas = (suggestedTip * TIP_MULTIPLIERS[level]) / 100n;
  return { maxFeePerGas: 2n * baseFeePerGas + maxPriorityFeePerGas, maxPriorityFeePerGas };
}

/**
 * Fallback tiers on `qrl_gasPrice`, for a node or proxy that does not serve
 * `qrl_maxPriorityFeePerGas` or a latest block without a base fee. Keeps the
 * priority tip within the selected total fee cap.
 */
export function applyFeeLevel(
  base: bigint,
  level: FeeLevel,
): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } {
  const mult: Record<FeeLevel, bigint> = { low: 100n, medium: 120n, high: 150n };
  const maxFeePerGas = (base * mult[level]) / 100n;
  // Prefer 10% of base with a 1 gwei floor, subject to the total fee cap.
  const tip = base / 10n;
  const preferredTip = tip > 1_000_000_000n ? tip : 1_000_000_000n;
  const maxPriorityFeePerGas = preferredTip > maxFeePerGas ? maxFeePerGas : preferredTip;
  return { maxFeePerGas, maxPriorityFeePerGas };
}

/** The fields of the latest block a build reads. Node output, so unvalidated. */
interface LatestBlock {
  gasLimit?: unknown;
  baseFeePerGas?: unknown;
}

const QUANTITY_RE = /^0x[0-9a-fA-F]+$/;

async function getLatestBlock(): Promise<LatestBlock> {
  const block = await rpcRead<LatestBlock | null>('qrl_getBlockByNumber', ['latest', false]);
  return block ?? {};
}

/**
 * Price a build at the selected level. Prefers the fee market (suggested tip
 * plus the latest base fee) and falls back to the `qrl_gasPrice` tiers when
 * either read fails or the block reports no usable base fee.
 */
async function quoteFees(level: FeeLevel, latestBlock: Promise<LatestBlock>): Promise<FeeQuote> {
  try {
    const [tip, block] = await Promise.all([
      rpcRead<unknown>('qrl_maxPriorityFeePerGas', []),
      latestBlock,
    ]);
    const baseFee = block.baseFeePerGas;
    if (typeof tip !== 'string' || !QUANTITY_RE.test(tip)) {
      throw new Error('rpc qrl_maxPriorityFeePerGas: no usable tip');
    }
    if (typeof baseFee !== 'string' || !QUANTITY_RE.test(baseFee)) {
      throw new Error('rpc qrl_getBlockByNumber: latest block reported no usable base fee');
    }
    return marketFees(hexToBigInt(tip), hexToBigInt(baseFee), level);
  } catch {
    return applyFeeLevel(await getGasPrice(), level);
  }
}

/** Gas-estimate buffer, mirroring the web wallet's GAS_ESTIMATE_BUFFER_MULTIPLIER. */
const GAS_ESTIMATE_BUFFER_PCT = 120n;

/**
 * Estimate the complete transfer via qrl_estimateGas, with a 1.2x buffer.
 * Empty calldata can still execute a recipient contract's receive handler.
 * An estimate error propagates so construction stops when execution would fail.
 */
async function estimateGas(
  req: BuildTransactionRequest,
  data: string,
  fees: FeeQuote,
): Promise<bigint> {
  const estimated = hexToBigInt(
    await rpcRead<string>('qrl_estimateGas', [
      {
        from: req.from,
        to: req.to,
        value: `0x${BigInt(req.value).toString(16)}`,
        data,
        maxFeePerGas: `0x${fees.maxFeePerGas.toString(16)}`,
        maxPriorityFeePerGas: `0x${fees.maxPriorityFeePerGas.toString(16)}`,
      },
    ]),
  );
  return (estimated * GAS_ESTIMATE_BUFFER_PCT) / 100n;
}

/**
 * The latest block's gas limit: the ceiling a single transaction's gas limit
 * can usefully claim, since a block can never include more.
 *
 * Every build reads the latest block once: its base fee prices the
 * transaction, and on the dApp-gas path its gas limit bounds a requested
 * limit. `REQUEST_SIGNATURE` reads it again to bound whatever gas limit
 * actually reaches the signer. The build-time check alone would only cover
 * transactions main assembled; the renderer supplies the transaction it asks
 * to have signed, so the signing-time check is the one that holds for every
 * signature.
 */
export async function getBlockGasLimit(): Promise<bigint> {
  return blockGasLimit(await getLatestBlock());
}

function blockGasLimit(block: LatestBlock): bigint {
  const raw = block.gasLimit;
  if (typeof raw !== 'string' || !QUANTITY_RE.test(raw)) {
    throw new Error('rpc qrl_getBlockByNumber: latest block reported no usable gas limit');
  }
  const limit = hexToBigInt(raw);
  if (limit <= 0n) {
    throw new Error('rpc qrl_getBlockByNumber: latest block reported a zero gas limit');
  }
  return limit;
}

/**
 * Resolve the gas limit for a build, and report the estimate it was compared
 * against so main can remember it for the trusted confirm window.
 *
 * With no dApp-requested limit this is exactly the historical behaviour: the
 * node's estimate with a 1.2x buffer, uncapped. With one, the result is the
 * LARGER of the request and the estimate, with both bounded by the latest
 * block's gas limit:
 *
 *  - a request BELOW the estimate cannot strand the user with an out-of-gas
 *    transaction, because the estimate still floors the limit;
 *  - a request ABOVE the estimate is honoured exactly as given, which is what
 *    contract flows with estimate-invisible headroom (QuantaSwap HTLCv3
 *    settlement) need;
 *  - a request above the block gas limit is rejected with a clear error;
 *  - a 1.2x BUFFERED ESTIMATE above the block gas limit is clamped to that
 *    ceiling, so the buffer cannot push a near-block-sized call past a limit
 *    the requested value was already checked against.
 *
 * The limit returned here is the limit written into the unsigned transaction,
 * so it is also the gas limit and max cost the trusted confirm window shows.
 */
async function resolveGasLimit(
  req: BuildTransactionRequest,
  data: string,
  fees: FeeQuote,
  latestBlock: Promise<LatestBlock>,
): Promise<{ gas: bigint; estimated: bigint }> {
  const estimated = await estimateGas(req, data, fees);
  if (req.gas === undefined) return { gas: estimated, estimated };
  const requested = BigInt(req.gas);
  // The fee quote tolerates a failed block read by falling back; the ceiling
  // never does, so a failed read fails the build here.
  const ceiling = blockGasLimit(await latestBlock);
  if (requested > ceiling) {
    throw new Error(
      `requested gas limit ${requested.toString(10)} exceeds the block gas limit ${ceiling.toString(10)}`,
    );
  }
  const floor = estimated > ceiling ? ceiling : estimated;
  return { gas: requested > floor ? requested : floor, estimated };
}

/** Assemble a complete unsigned type-2 transaction ready for the signer. */
export async function buildTransaction(req: BuildTransactionRequest): Promise<UnsignedTransaction> {
  // HexSchema admits bare hex; JSON-RPC wants the 0x-prefixed form, so
  // canonicalize once and use it for both the estimate and the built tx.
  const data = req.data ? (req.data.startsWith('0x') ? req.data : `0x${req.data}`) : undefined;
  // One latest-block read serves both the fee quote (base fee) and the
  // dApp gas ceiling (gas limit).
  const latestBlock = getLatestBlock();
  const [nonce, fees, chainId] = await Promise.all([
    getTransactionCount(req.from),
    quoteFees(req.feeLevel, latestBlock),
    getChainId(),
  ]);
  const { maxFeePerGas, maxPriorityFeePerGas } = fees;
  // Estimate every recipient, including value transfers with empty calldata.
  const { gas, estimated } = await resolveGasLimit(req, data ?? '0x', fees, latestBlock);
  const tx: UnsignedTransaction = {
    from: req.from,
    to: req.to,
    value: req.value,
    nonce,
    gas: gas.toString(10),
    maxFeePerGas: maxFeePerGas.toString(10),
    maxPriorityFeePerGas: maxPriorityFeePerGas.toString(10),
    chainId,
    type: '0x2',
    ...(data ? { data } : {}),
  };
  // Keep main's own estimate for this exact transaction so the trusted confirm
  // window can name where the gas limit came from.
  rememberBuild(tx, {
    estimatedGas: estimated.toString(10),
    ...(req.gas === undefined ? {} : { requestedGas: req.gas }),
  });
  return tx;
}

/**
 * A node that already holds THIS exact tx (same hash) rejects with an
 * "already known" family message. Because a duplicate is keyed on the tx HASH,
 * the node holding it means our exact signed tx is in the mempool: when we
 * know that hash, a duplicate rejection is a SUCCESSFUL (idempotent) broadcast,
 * not a failure. Deliberately NOT "nonce too low": that means a tx with the
 * same NONCE is already mined, which may be a DIFFERENT tx, so treating it as
 * success could report a hash that never mines.
 */
const DUPLICATE_TX_RE = /already known|known transaction|already exists/i;

/**
 * Broadcast a signed raw tx. `expectedHash` (the signer-computed tx hash, held
 * by main from the signature it just brokered, never renderer-supplied) lets a
 * duplicate-known rejection resolve to that hash instead of failing: covers the
 * "primary timed out AFTER the tx reached the node, retry hits the same pool
 * which now reports it as known" case that would otherwise surface as a
 * failure and tempt the user into a second (double-spending) send.
 *
 * Prefers the primary; fails over to the secondary ONLY on a transport failure
 * (a JSON-RPC rejection means a node answered and refused, which must surface).
 * Rebroadcasting an identical raw tx is idempotent (same hash, nonce-protected).
 */
export async function sendRawTransaction(
  rawTx: string,
  expectedHash?: string,
): Promise<{ transactionHash: string }> {
  const broadcastOn = async (url: string): Promise<{ transactionHash: string }> => {
    await assertEndpointIdentity(url);
    try {
      const hash = await rpcCallOn<string>(url, 'qrl_sendRawTransaction', [rawTx]);
      return { transactionHash: hash };
    } catch (err) {
      if (
        expectedHash &&
        err instanceof Error &&
        !(err instanceof RpcTransportError) &&
        DUPLICATE_TX_RE.test(err.message)
      ) {
        return { transactionHash: expectedHash };
      }
      throw err;
    }
  };

  try {
    return await broadcastOn(RPC_URL);
  } catch (primaryErr) {
    if (
      !(primaryErr instanceof RpcTransportError) ||
      !RPC_URL_SECONDARY ||
      RPC_URL_SECONDARY === RPC_URL
    ) {
      throw primaryErr;
    }
    try {
      return await broadcastOn(RPC_URL_SECONDARY);
    } catch (secondaryErr) {
      // Chain the primary's transport error as the cause so a dual failure
      // carries BOTH endpoints' diagnostics, not just the secondary's. Preserve
      // the RpcTransportError type when the secondary also failed at transport.
      if (secondaryErr instanceof RpcTransportError) {
        throw new RpcTransportError(secondaryErr.message, { cause: primaryErr });
      }
      throw secondaryErr instanceof Error
        ? new Error(secondaryErr.message, { cause: primaryErr })
        : secondaryErr;
    }
  }
}
