/**
 * Cross-process constants shared by main, preload, signer and renderer.
 *
 * This module must stay dependency-free and side-effect-free: it is imported
 * by the sandboxed preload (which can only load a tiny allowlist of modules),
 * by the signer utilityProcess, and by the renderer bundle. Keep it pure data.
 */

/**
 * IPC channels exposed to the renderer through the preload contextBridge.
 * Every channel is request/response (`ipcRenderer.invoke` / `ipcMain.handle`).
 * The renderer never sees these strings directly: the preload wraps each one
 * in a narrow named function, so a compromised renderer cannot invoke an
 * arbitrary channel.
 */
export const IPC = {
  /** Returns the on-chain balance for an address (read-only, no unlock). */
  GET_BALANCE: 'wallet:getBalance',
  /** Assembles an unsigned transaction (nonce/gas/chainId filled from RPC). */
  BUILD_TRANSACTION: 'wallet:buildTransaction',
  /** Confirms intent in a trusted modal, then signs in the signer process. */
  REQUEST_SIGNATURE: 'wallet:requestSignature',
  /** Derives the KEK from the password and opens an in-memory signer session. */
  UNLOCK: 'wallet:unlock',

  // ---- Lifecycle surface (kept deliberately small) -----------------------
  // The four channels above are the spend-path API named in the build brief.
  // A working wallet additionally needs to be provisioned and queried; these
  // are the minimum extra channels for that, all equally sender+schema gated.
  /** True once an encrypted seed exists on disk for this app data dir. */
  HAS_WALLET: 'wallet:hasWallet',
  /** Generates a fresh wallet INSIDE the signer; returns the mnemonic once for
   * backup (never the hex seed/secret key), encrypts + persists it. */
  CREATE_WALLET: 'wallet:createWallet',
  /** Imports a mnemonic, encrypts the seed under a password, persists it. */
  IMPORT_WALLET: 'wallet:importWallet',
  /** Current lock state + active address (no secrets). */
  GET_STATUS: 'wallet:getStatus',
  /** Zeroizes the signer session immediately. */
  LOCK: 'wallet:lock',
  /** Destructively removes ONE wallet (the active one, or an explicit address):
   * deletes its encrypted seed from disk and clears its OS-keychain entry;
   * drops the session when it was the unlocked account. Requires re-import
   * (mirrors the mobile-app wipe). */
  REMOVE_WALLET: 'wallet:removeWallet',
  /** Lists every provisioned wallet (address + keychain backing) + the active one. */
  LIST_WALLETS: 'wallet:listWallets',
  /** Switches the active wallet. Locks the session when it was open for a
   * different account (the new account needs its own unlock). */
  SET_ACTIVE_WALLET: 'wallet:setActiveWallet',
  /** Broadcasts a signed raw transaction via the RPC proxy. */
  SEND_RAW_TRANSACTION: 'wallet:sendRawTransaction',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

/** Renderer-facing event channels (main -> renderer, one-way). */
export const EVENTS = {
  /** Emitted with a boolean `locked` whenever the signer session changes. */
  LOCK_STATE_CHANGED: 'wallet:lockStateChanged',
} as const;

/** The global the preload mounts on `window`. */
export const BRIDGE_KEY = 'qrlWallet';

/**
 * Internal message types on the private main <-> signer channel. These never
 * cross the contextBridge; the renderer cannot address the signer at all.
 */
export const SIGNER_MSG = {
  READY: 'signer:ready',
  CREATE: 'signer:create',
  IMPORT: 'signer:import',
  UNLOCK: 'signer:unlock',
  SIGN: 'signer:sign',
  LOCK: 'signer:lock',
  STATUS: 'signer:status',
  SHUTDOWN: 'signer:shutdown',
} as const;

export type SignerMsgType = (typeof SIGNER_MSG)[keyof typeof SIGNER_MSG];

/**
 * ML-DSA-87 (FIPS 204, NIST L5) byte lengths, copied from @theqrl/mldsa87
 * 2.1.1. Hard-coded here as cross-checks so a silent dependency bump that
 * changes a size is caught by an assertion rather than producing malformed
 * signatures. (The stale `4595` in the frontend comments was the old
 * Dilithium5 size; ML-DSA-87 detached signatures are 4627 bytes.)
 */
export const MLDSA87 = {
  PUBLIC_KEY_BYTES: 2592,
  SECRET_KEY_BYTES: 4896,
  SIGNATURE_BYTES: 4627,
  /** SHAKE256 digest length the wallet signs over (L5-matched). */
  DIGEST_BYTES: 64,
  /** wallet.js extended-seed length: 3-byte descriptor || 48-byte seed. */
  EXTENDED_SEED_BYTES: 51,
} as const;

/**
 * Domain-separation context tags. These MUST byte-match the wallet/SDK
 * (`src/utils/signing/ctx.ts` in myqrlwallet-frontend) or signatures will not
 * verify against the dApp side. Encoded to bytes in the signer.
 */
export const SCHEME = {
  TAG_MSG: 'QRL-SIGN-MSG-v1',
  TAG_TYPED: 'QRL-SIGN-TYPED-v1',
  VERSION_MSG: 1,
  VERSION_TYPED: 1,
} as const;

/**
 * Argon2id KEK-derivation parameters. `memoryCost` is in KiB (262144 = 256 MiB).
 * These are a STARTING POINT calibrated to land near 500 ms on commodity 2024
 * laptop hardware; they MUST be re-benchmarked on the real target with
 * `npm run calibrate:kdf` and frozen, because the exact values are persisted
 * with every encrypted seed and changing them breaks decryption of existing
 * wallets. The version/algorithm are pinned for long-term determinism.
 */
export const KDF_DEFAULTS = {
  /** @node-rs/argon2 Algorithm.Argon2id === 2 */
  algorithm: 2,
  /** @node-rs/argon2 Version.V0x13 === 1 */
  version: 1,
  memoryCost: 262144,
  timeCost: 3,
  parallelism: 1,
  /** 256-bit KEK. */
  outputLen: 32,
  /** 128-bit salt; generated fresh per wallet and stored alongside ciphertext. */
  saltBytes: 16,
} as const;

export type KdfParams = typeof KDF_DEFAULTS;

/** AES-256-GCM envelope constants. */
export const AEAD = {
  /** 96-bit nonce, the GCM standard. Fresh per encryption. */
  IV_BYTES: 12,
  /** 128-bit authentication tag. */
  TAG_BYTES: 16,
  KEY_BYTES: 32,
} as const;

/** Current on-disk encrypted-seed format. Bump on any breaking change. */
export const SEED_FILE_VERSION = 'qrl-desktop-seed-v1';

/** Default auto-lock idle timeout (ms) before the signer zeroizes the session. */
export const DEFAULT_AUTOLOCK_MS = 5 * 60 * 1000;
