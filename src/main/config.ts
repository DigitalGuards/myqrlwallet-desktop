/**
 * Runtime configuration for the main process.
 *
 * RPC endpoints are read from the environment so a build can be repointed
 * without code changes; defaults track the QRL testnet-v2 node documented in
 * the workspace CLAUDE.md. `connect-src` in the CSP is derived from exactly
 * these origins so the renderer can reach the configured RPC and nothing else.
 */
import { DEFAULT_AUTOLOCK_MS } from '../shared/constants';

function envUrl(name: string, fallback: string): string {
  const v = process.env[name];
  if (!v) return fallback;
  try {
    // normalise + validate
    return new URL(v).toString().replace(/\/$/, '');
  } catch {
    return fallback;
  }
}

/** Primary JSON-RPC endpoint (QRL v2 `qrl_*` namespace). */
export const RPC_URL = envUrl('QRL_RPC_URL', 'http://REDACTED:8545');

/** Optional secondary endpoint (foundation public RPC) for read failover. */
export const RPC_URL_SECONDARY = envUrl('QRL_RPC_URL_SECONDARY', 'http://209.250.255.226:8545');

/** Fallback chain id if `qrl_chainId` cannot be read (testnet-v2 = 1337). */
export const FALLBACK_CHAIN_ID = Number(process.env.QRL_CHAIN_ID ?? 1337);

/** Idle timeout before the signer auto-locks. */
export const AUTOLOCK_MS = Number(process.env.QRL_AUTOLOCK_MS ?? DEFAULT_AUTOLOCK_MS);

/**
 * `connect-src` allowlist for the strict CSP. The renderer is permitted to
 * talk to the configured RPC origins (and `self`) and nothing else. When the
 * reused web frontend needs the backend proxy / relay, add those origins here.
 */
export function connectSrcOrigins(): string[] {
  const origins = new Set<string>();
  for (const url of [RPC_URL, RPC_URL_SECONDARY]) {
    try {
      origins.add(new URL(url).origin);
    } catch {
      /* ignore malformed */
    }
  }
  return [...origins];
}

export const APP_ID = 'com.digitalguards.qrlwallet.desktop';
export const PRODUCT_NAME = 'MyQRLWallet';
