/**
 * Minimal JSON-RPC client + transaction assembly. This is the seed of the
 * "bundled local RPC proxy" the desktop app becomes (Stage 3 of the research
 * roadmap): today it talks directly to the configured QRL v2 `qrl_*` endpoint,
 * with a read-only failover to the secondary. Signing/broadcast stay separate
 * (signing is in the signer; broadcast is `sendRawTransaction` here).
 *
 * No secrets pass through this module.
 */
import { FALLBACK_CHAIN_ID, RPC_URL, RPC_URL_SECONDARY } from './config';
import type { BuildTransactionRequest, FeeLevel, UnsignedTransaction } from '../shared/schemas';

interface JsonRpcResponse<T> {
  jsonrpc: '2.0';
  id: number;
  result?: T;
  error?: { code: number; message: string };
}

let rpcId = 0;

async function rpcCallOn<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    // The signer, not main, never makes RPC calls; this is main's proxy.
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`rpc ${method} http ${res.status}`);
  const body = (await res.json()) as JsonRpcResponse<T>;
  if (body.error) throw new Error(`rpc ${method}: ${body.error.message}`);
  if (body.result === undefined) throw new Error(`rpc ${method}: empty result`);
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

export async function getChainId(): Promise<number> {
  try {
    return Number(hexToBigInt(await rpcRead<string>('qrl_chainId', [])));
  } catch {
    return FALLBACK_CHAIN_ID;
  }
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

export async function sendRawTransaction(rawTx: string): Promise<{ transactionHash: string }> {
  // Broadcast is primary-only (the secondary may not accept writes).
  const hash = await rpcCallOn<string>(RPC_URL, 'qrl_sendRawTransaction', [rawTx]);
  return { transactionHash: hash };
}
