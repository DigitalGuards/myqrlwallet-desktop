/**
 * Minimal JSON-RPC client + transaction assembly. This is the seed of the
 * "bundled local RPC proxy" the desktop app becomes (Stage 3 of the research
 * roadmap): today it talks to the configured QRL v2 `qrl_*` endpoints (by
 * default the wallet backend's RPC proxies, see config.ts), reads failing
 * over to the secondary and broadcast failing over on transport errors only.
 * Signing stays separate (in the signer); broadcast is `sendRawTransaction`
 * here.
 *
 * No secrets pass through this module.
 */
import { RPC_URL, RPC_URL_SECONDARY } from './config';
import type { BuildTransactionRequest, FeeLevel, UnsignedTransaction } from '../shared/schemas';

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

/** Read-only call with failover to the secondary endpoint. */
async function rpcRead<T>(method: string, params: unknown[]): Promise<T> {
  try {
    return await rpcCallOn<T>(RPC_URL, method, params);
  } catch (primaryErr) {
    if (RPC_URL_SECONDARY && RPC_URL_SECONDARY !== RPC_URL) {
      try {
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
  return Number(hexToBigInt(await rpcRead<string>('qrl_chainId', [])));
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

/** Fee-level multiplier, mirroring the web wallet's `applyFeeLevel`. Exported
 * for unit testing (pure bigint arithmetic; no network). */
export function applyFeeLevel(
  base: bigint,
  level: FeeLevel,
): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } {
  const mult: Record<FeeLevel, bigint> = { low: 100n, medium: 120n, high: 150n };
  const maxFeePerGas = (base * mult[level]) / 100n;
  // Priority tip = 10% of base, floored at 1 gwei.
  const tip = base / 10n;
  const maxPriorityFeePerGas = tip > 1_000_000_000n ? tip : 1_000_000_000n;
  return { maxFeePerGas, maxPriorityFeePerGas };
}

/** Assemble a complete unsigned type-2 transaction ready for the signer. */
export async function buildTransaction(req: BuildTransactionRequest): Promise<UnsignedTransaction> {
  const [nonce, base, chainId] = await Promise.all([
    getTransactionCount(req.from),
    getGasPrice(),
    getChainId(),
  ]);
  const { maxFeePerGas, maxPriorityFeePerGas } = applyFeeLevel(base, req.feeLevel);
  // Native transfer = 21000; a contract call would estimate via qrl_estimateGas.
  const gas = req.data && req.data !== '0x' ? 90_000n : 21_000n;
  return {
    from: req.from,
    to: req.to,
    value: req.value,
    nonce,
    gas: gas.toString(10),
    maxFeePerGas: maxFeePerGas.toString(10),
    maxPriorityFeePerGas: maxPriorityFeePerGas.toString(10),
    chainId,
    type: '0x2',
    ...(req.data ? { data: req.data } : {}),
  };
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
