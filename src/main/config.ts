import type { QrlWalletNetwork } from '../shared/bridge';

/**
 * Runtime configuration for the main process.
 *
 * The network the app runs on is fixed when it is built: QRL_NETWORK_PROFILE
 * selects one row of NETWORKS below, and every network pin in main, the wallet
 * bridge and the bundled renderer comes from that row.
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
function envUrlOptional(name: string, fallback: string | undefined): string | undefined {
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

/** Build profiles. QRL_NETWORK_PROFILE picks one when the app is BUILT; testnet is the default. */
export type NetworkProfileName = 'testnet' | 'mainnet';

/** One network the desktop wallet can be built for. */
export interface NetworkTableEntry {
  /** Advertised to the renderer as window.qrlWallet.network.networkProfile. */
  readonly networkProfile: 'v3-private' | 'v3-mainnet';
  /** userData subdirectory: each network keeps its own wallets, settings and browser storage. */
  readonly userDataDir: 'v3-private' | 'v3-mainnet';
  /** Chain id pin; null until the network's identity is published. */
  readonly chainId: number | null;
  /** Genesis block hash pin (lowercase hex); null until the network's identity is published. */
  readonly genesisHash: string | null;
  /** The network segment of the backend RPC proxy path, /api/qrl-rpc/<rpcPath>. */
  readonly rpcPath: 'testnet' | 'mainnet';
  /** Default primary JSON-RPC endpoint. QRL_RPC_URL replaces it at runtime. */
  readonly rpcUrl: string;
  /** Default failover endpoint, null for none. QRL_RPC_URL_SECONDARY replaces it at runtime. */
  readonly rpcUrlSecondary: string | null;
  /** QNS registry the renderer resolves .qrl names with; empty builds it without names. */
  readonly qnsRegistry: string;
}

/**
 * The network table: the one place the desktop wallet's network identity is
 * written down. Main pins every RPC endpoint and every signature to the
 * selected row, the wallet bridge advertises it, and scripts/build-renderer.sh
 * bakes the same values into the renderer.
 *
 * Mainnet is dormant. Its chain id and genesis hash stay null until QRL 2.0
 * mainnet publishes them, and while they are null a mainnet build refuses to
 * build and to start. It has no failover endpoint by default because the dev
 * backend pins no mainnet identity yet. Launch day: fill in both pins here.
 */
export const NETWORKS: Readonly<Record<NetworkProfileName, NetworkTableEntry>> = Object.freeze({
  testnet: Object.freeze({
    networkProfile: 'v3-private',
    userDataDir: 'v3-private',
    chainId: 3151909,
    genesisHash: '0xd15407991193e6c23b733dc6bf9c628deaff8f9b6e252aa0d60030952b3e3ea4',
    rpcPath: 'testnet',
    rpcUrl: 'https://qrlwallet.com/api/qrl-rpc/testnet',
    // The dev backend's RPC proxy: an independent deployment over the same
    // node pool.
    rpcUrlSecondary: 'https://dev.qrlwallet.com/api/qrl-rpc/testnet',
    // The QNS registry qrlwallet.com uses: Send resolves names ending in .qrl.
    qnsRegistry:
      'Qcfc5f3242cE7d413F308D4181fd45D441d535298d78fd2d26833c2650408f636B46590dc10D23221480eFac958705Ba6C266eEB16B5aeafA64202715Adc84424',
  }),
  mainnet: Object.freeze({
    networkProfile: 'v3-mainnet',
    userDataDir: 'v3-mainnet',
    chainId: null,
    genesisHash: null,
    rpcPath: 'mainnet',
    rpcUrl: 'https://qrlwallet.com/api/qrl-rpc/mainnet',
    rpcUrlSecondary: null,
    qnsRegistry: '',
  }),
});

/** A network with both identity pins: the only kind this app runs on. */
export interface PinnedNetwork extends NetworkTableEntry {
  readonly profile: NetworkProfileName;
  readonly chainId: number;
  readonly genesisHash: string;
}

/** The build's network profile cannot run: it is unknown or its identity is not pinned. */
export class NetworkProfileError extends Error {}

const GENESIS_HASH_RE = /^0x[0-9a-f]{64}$/;
const QNS_REGISTRY_RE = /^(?:Q[0-9a-fA-F]{128})?$/;

/** Reads a QRL_NETWORK_PROFILE value. Unset or empty selects testnet. */
export function networkProfileName(value: unknown): NetworkProfileName {
  if (value === undefined || value === '') return 'testnet';
  if (value === 'testnet' || value === 'mainnet') return value;
  throw new NetworkProfileError('QRL_NETWORK_PROFILE must be testnet or mainnet');
}

/**
 * The pinned network for a build profile. Throws NetworkProfileError for an
 * unknown profile, a network missing either identity pin, a malformed pin,
 * and a network whose chain id, genesis hash, RPC endpoint, profile name or
 * data directory equals another row's. `table` is a parameter so tests can
 * exercise a pinned mainnet without editing NETWORKS.
 */
export function resolveNetwork(
  value: unknown,
  table: Readonly<Record<NetworkProfileName, NetworkTableEntry>> = NETWORKS,
): PinnedNetwork {
  const profile = networkProfileName(value);
  const entry = table[profile];
  const { chainId, genesisHash } = entry;
  if (chainId === null && genesisHash === null) {
    throw new NetworkProfileError(
      `The ${profile} network has no pinned chain id and genesis hash yet, so this build cannot run on it.`,
    );
  }
  if (chainId === null || genesisHash === null) {
    throw new NetworkProfileError(
      `The ${profile} network needs both a chain id and a genesis hash.`,
    );
  }
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new NetworkProfileError(`The ${profile} chain id must be a positive integer.`);
  }
  if (!GENESIS_HASH_RE.test(genesisHash)) {
    throw new NetworkProfileError(`The ${profile} genesis hash must be a lowercase 32-byte hash.`);
  }
  if (!QNS_REGISTRY_RE.test(entry.qnsRegistry)) {
    throw new NetworkProfileError(`The ${profile} QNS registry must be empty or a QRL address.`);
  }
  if (!entry.rpcUrl.endsWith(`/${entry.rpcPath}`)) {
    throw new NetworkProfileError(`The ${profile} RPC endpoint must end with /${entry.rpcPath}.`);
  }
  const ownEndpoints = [entry.rpcUrl, entry.rpcUrlSecondary].filter((url) => url !== null);
  for (const [name, other] of Object.entries(table)) {
    if (name === profile) continue;
    if (other.chainId === chainId || other.genesisHash?.toLowerCase() === genesisHash) {
      throw new NetworkProfileError(`The ${profile} network identity must differ from ${name}.`);
    }
    const otherEndpoints = [other.rpcUrl, other.rpcUrlSecondary];
    if (ownEndpoints.some((url) => otherEndpoints.includes(url))) {
      throw new NetworkProfileError(`The ${profile} RPC endpoints must differ from ${name}.`);
    }
    if (
      other.networkProfile === entry.networkProfile ||
      other.userDataDir === entry.userDataDir ||
      other.rpcPath === entry.rpcPath
    ) {
      throw new NetworkProfileError(
        `The ${profile} profile and data directory must differ from ${name}.`,
      );
    }
  }
  return Object.freeze({ ...entry, profile, chainId, genesisHash });
}

const chainIdHex = (chainId: number): string => `0x${chainId.toString(16)}`;

/** The network record the wallet bridge advertises as window.qrlWallet.network. */
export function nativeNetworkCapability(network: PinnedNetwork): QrlWalletNetwork {
  return {
    networkProfile: network.networkProfile,
    chainId: chainIdHex(network.chainId),
    genesisHash: network.genesisHash,
  };
}

/**
 * Build-time constants for the main and preload bundles (electron.vite.config.ts).
 * Throws for a profile that cannot run, so an unpinned mainnet stops
 * `electron-vite build` and `dev`, which every `dist*` script runs first.
 */
export function networkBuildDefines(
  value: unknown,
): Readonly<Record<'__QRL_NETWORK_PROFILE__' | '__QRL_WALLET_NETWORK__', string>> {
  const network = resolveNetwork(value);
  return {
    __QRL_NETWORK_PROFILE__: JSON.stringify(network.profile),
    __QRL_WALLET_NETWORK__: JSON.stringify(nativeNetworkCapability(network)),
  };
}

/**
 * The network values scripts/build-renderer.sh bakes into the renderer
 * (printed by scripts/network-values.mjs). The testnet block is always there
 * because the reused frontend's v3 profile requires it; a mainnet build adds
 * the mainnet block. Throws for a profile that cannot run.
 */
export function rendererNetworkValues(
  value: unknown,
  table: Readonly<Record<NetworkProfileName, NetworkTableEntry>> = NETWORKS,
): readonly (readonly [string, string])[] {
  const network = resolveNetwork(value, table);
  const testnet = resolveNetwork('testnet', table);
  const values: (readonly [string, string])[] = [
    ['NETWORK_PROFILE', network.profile],
    ['TESTNET_CHAIN_ID', chainIdHex(testnet.chainId)],
    ['TESTNET_GENESIS_HASH', testnet.genesisHash],
    ['TESTNET_RPC_PATH', testnet.rpcPath],
    ['TESTNET_QNS_REGISTRY', testnet.qnsRegistry],
  ];
  if (network.profile === 'mainnet') {
    values.push(
      ['MAINNET_CHAIN_ID', chainIdHex(network.chainId)],
      ['MAINNET_GENESIS_HASH', network.genesisHash],
      ['MAINNET_RPC_PATH', network.rpcPath],
      ['MAINNET_QNS_REGISTRY', network.qnsRegistry],
    );
  }
  return values;
}

// Replaced by electron-vite with the build's profile (networkBuildDefines), so
// a packaged app keeps the network it was built for and no launch-time
// environment can move it to another one. The environment is read only where
// the constant is absent: source-level tests and tooling.
declare const __QRL_NETWORK_PROFILE__: string | undefined;
const BUILD_NETWORK_PROFILE: unknown =
  typeof __QRL_NETWORK_PROFILE__ === 'string'
    ? __QRL_NETWORK_PROFILE__
    : process.env['QRL_NETWORK_PROFILE'];

/** The pinned network a build profile runs on, or the reason it cannot run. */
export type NetworkSelection =
  | { readonly network: PinnedNetwork; readonly error: null }
  | { readonly network: null; readonly error: string };

/**
 * resolveNetwork as a value: the pinned network, or the NetworkProfileError
 * message for a profile that cannot run. pinnedNetwork() serves the build's
 * selection from NETWORKS; tests pass a table with a pinned mainnet row.
 */
export function selectNetwork(
  value: unknown,
  table: Readonly<Record<NetworkProfileName, NetworkTableEntry>> = NETWORKS,
): NetworkSelection {
  try {
    return { network: resolveNetwork(value, table), error: null };
  } catch (err) {
    if (err instanceof NetworkProfileError) return { network: null, error: err.message };
    throw err;
  }
}

/** Never throws at import: electron.vite.config.ts and the tests load this module. */
const SELECTION = selectNetwork(BUILD_NETWORK_PROFILE);

/** The table row the build names, pinned or not; undefined for an unknown profile. */
function buildTableEntry(value: unknown): NetworkTableEntry | undefined {
  try {
    return NETWORKS[networkProfileName(value)];
  } catch {
    return undefined;
  }
}
const BUILD_ENTRY = buildTableEntry(BUILD_NETWORK_PROFILE);

/**
 * The pinned network this build runs on. Throws NetworkProfileError when the
 * build's network has no pinned identity: main refuses to start on it
 * (src/main/index.ts), and RPC and signing refuse before any request.
 */
export function pinnedNetwork(): PinnedNetwork {
  if (SELECTION.network === null) throw new NetworkProfileError(SELECTION.error);
  return SELECTION.network;
}

/** Primary JSON-RPC endpoint (QRL v3 `qrl_*` namespace): the prod backend's
 * RPC proxy for the build's network, matching the bundled renderer's provider
 * URL. Export QRL_RPC_URL (and the VITE_* dev vars for the renderer) to
 * build/run a staging app. Every endpoint must serve the pinned identity. */
export const RPC_URL = envUrl('QRL_RPC_URL', BUILD_ENTRY?.rpcUrl ?? '');

/** Secondary endpoint for failover, by default the table row's. Set
 * QRL_RPC_URL_SECONDARY to an empty string / "none" / "off" to disable failover
 * entirely (e.g. when the primary is a private node no shared proxy must ever
 * see). */
export const RPC_URL_SECONDARY = envUrlOptional(
  'QRL_RPC_URL_SECONDARY',
  BUILD_ENTRY?.rpcUrlSecondary ?? undefined,
);

// The autolock idle timeout is no longer a boot-time constant: it resolves per
// unlock as env QRL_AUTOLOCK_MS > settings store > DEFAULT_AUTOLOCK_MS. See
// getEffectiveAutolockMs() in src/main/settingsFile.ts.

/**
 * Origins the reused myqrlwallet-frontend talks to at runtime: the backend
 * tx-history/token API + the dApp-connect relay + the explorer. The desktop
 * build targets PRODUCTION (qrlwallet.com); the bundled renderer is built
 * with matching prod env vars (scripts/build-renderer.sh). Override with
 * QRL_FRONTEND_ORIGINS (space-separated) to repoint at the dev stack.
 */
function frontendOrigins(): string[] {
  const fromEnv = process.env['QRL_FRONTEND_ORIGINS'];
  if (fromEnv) return fromEnv.split(/\s+/).filter(Boolean);
  return [
    // prod backend: tx-history / token API, its websocket, and the
    // dApp-connect relay (same origin).
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

/** Backend image origin, selected from the same build inputs as build-renderer.sh. */
export function rendererServerOrigin(): string {
  const mode = process.env.VITE_NODE_ENV;
  const production = !mode || mode === 'production';
  const server = production
    ? process.env.VITE_SERVER_URL_PRODUCTION
    : process.env.VITE_SERVER_URL_DEVELOPMENT;
  const fallback = production ? 'https://qrlwallet.com/api' : 'https://dev.qrlwallet.com/api';
  return `https://${new URL(server === undefined || server === '' ? fallback : server).host}`;
}

export const APP_ID = 'com.digitalguards.qrlwallet.desktop';
export const PRODUCT_NAME = 'MyQRLWallet';
