/**
 * Runtime configuration for the main process.
 *
 * RPC endpoints are read from the environment so a build can be repointed
 * without code changes; defaults are the wallet BACKEND's JSON-RPC proxies
 * (the same path the bundled renderer uses), NOT bare node hosts: the proxy
 * is CF-fronted HTTPS (reachable from consumer networks that drop plain HTTP
 * to raw IPs) and does its own server-side node failover. `connect-src` in
 * the CSP is derived from exactly these origins so the renderer can reach the
 * configured RPC and nothing else.
 */
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

/** Sentinels that explicitly DISABLE an optional endpoint (no failover). */
const DISABLE_TOKENS = new Set(['', 'none', 'off', 'disabled']);

/**
 * An OPTIONAL endpoint: unset -> the default; explicitly blank/none/off ->
 * disabled (undefined); a valid URL -> that URL; set-but-malformed -> disabled
 * rather than silently re-defaulting. The last point matters: an operator who
 * points the primary at a private/local node must be able to turn the public
 * fallback OFF, and a typo must not silently leak a signed raw tx to the prod
 * proxy (or land it on a colliding chain id).
 */
function envUrlOptional(name: string, fallback: string): string | undefined {
  const v = process.env[name];
  if (v === undefined) return fallback;
  const trimmed = v.trim();
  if (DISABLE_TOKENS.has(trimmed.toLowerCase())) return undefined;
  try {
    return new URL(trimmed).toString().replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

/** Primary JSON-RPC endpoint (QRL v2 `qrl_*` namespace): the dev backend's
 * RPC proxy, matching the staging renderer's provider URL. */
export const RPC_URL = envUrl('QRL_RPC_URL', 'https://dev.qrlwallet.com/api/qrl-rpc/testnet');

/** Secondary endpoint for failover: the prod backend's RPC proxy (an
 * independent deployment over the same node pool). Set QRL_RPC_URL_SECONDARY
 * to an empty string / "none" / "off" to disable failover entirely (e.g. when
 * the primary is a private node the prod proxy must never see). */
export const RPC_URL_SECONDARY = envUrlOptional(
  'QRL_RPC_URL_SECONDARY',
  'https://qrlwallet.com/api/qrl-rpc/testnet',
);

// The autolock idle timeout is no longer a boot-time constant: it resolves per
// unlock as env QRL_AUTOLOCK_MS > settings store > DEFAULT_AUTOLOCK_MS. See
// getEffectiveAutolockMs() in src/main/settingsFile.ts.

/**
 * Origins the reused myqrlwallet-frontend talks to at runtime: the backend
 * tx-history/token API + the dApp-connect relay + the explorer. The desktop
 * build is a STAGING build that targets the dev environment (dev.qrlwallet.com,
 * which CICD auto-deploys on every push to the frontend `dev` branch); the
 * bundled renderer is built with matching dev env vars (scripts/build-renderer.sh).
 * Override with QRL_FRONTEND_ORIGINS (space-separated) to repoint at prod.
 */
function frontendOrigins(): string[] {
  const fromEnv = process.env['QRL_FRONTEND_ORIGINS'];
  if (fromEnv) return fromEnv.split(/\s+/).filter(Boolean);
  return [
    // dev backend: tx-history / token API and its websocket.
    'https://dev.qrlwallet.com',
    'wss://dev.qrlwallet.com',
    // dApp-connect relay. The dev frontend talks to the qrlwallet.com relay
    // (allowlisted, not proxied), so the desktop must reach it too or
    // dApp-connect (the rerouted approval/sign path) is CSP-blocked.
    'https://qrlwallet.com',
    'wss://qrlwallet.com',
    // block explorer API (token + NFT discovery).
    'https://zondscan.com',
  ];
}

/**
 * `connect-src` allowlist for the renderer CSP: `self` plus the configured RPC
 * origins plus the frontend's backend/relay/explorer origins. Nothing else is
 * reachable from the renderer.
 */
export function connectSrcOrigins(): string[] {
  const origins = new Set<string>();
  for (const url of [RPC_URL, RPC_URL_SECONDARY]) {
    if (!url) continue; // secondary may be disabled (undefined)
    try {
      origins.add(new URL(url).origin);
    } catch {
      /* ignore malformed */
    }
  }
  for (const o of frontendOrigins()) origins.add(o);
  return [...origins];
}

export const APP_ID = 'com.digitalguards.qrlwallet.desktop';
export const PRODUCT_NAME = 'MyQRLWallet';
