/**
 * Wire types for the private main <-> signer utilityProcess channel.
 *
 * These messages never touch the renderer. Every request carries a monotonic
 * `id` that the main-side bridge correlates with its pending promise. The
 * signer only ever replies; it never initiates except for the one-shot READY.
 *
 * SECURITY: plaintext key material (mnemonic, seed, secret key) lives ONLY in
 * the signer process and only transiently. The KEK is the one secret that may
 * cross this channel (to be stashed in the OS keychain as defense-in-depth);
 * see THREAT_MODEL.md for the honest tradeoff. The seed itself never crosses.
 */
import type { KdfParams } from './constants';
import type { SignatureRequest, SignatureResult } from './schemas';

/** One AES-256-GCM envelope (all hex). */
export interface AeadFields {
  /** AES-GCM nonce. */
  iv: string;
  /** AES-GCM ciphertext. */
  ciphertext: string;
  /** AES-GCM auth tag. */
  tag: string;
}

/**
 * The persisted encrypted-seed envelope. Stored as JSON on disk by main; the
 * signer is the only process that can turn it back into key material (it needs
 * the password-derived KEK). Nothing here is plaintext key material.
 *
 * The hex signing seed and the recovery mnemonic are encrypted SEPARATELY under
 * the same KEK so the hot signing path only ever decrypts (and briefly
 * string-materialises) the hex seed; the mnemonic is decrypted only on an
 * explicit export/backup operation, never on every signature.
 */
export interface EncryptedSeed {
  version: string;
  address: string;
  /** Argon2id params, frozen at provisioning so the KEK re-derives. */
  kdf: KdfParams;
  /** Hex, KDF salt. */
  salt: string;
  /** Encrypts the 51-byte hex extended seed (used on the signing path). */
  seed: AeadFields;
  /** Encrypts the recovery mnemonic (export/backup path only, not signing). */
  mnemonic: AeadFields;
  createdAt: number;
}

// ---- Requests (main -> signer) --------------------------------------------

interface BaseReq {
  id: number;
}

export interface CreateReq extends BaseReq {
  type: 'signer:create';
  password: string;
}

/**
 * Import from EITHER a mnemonic or a 51-byte hex extended seed (exactly one;
 * schema-enforced in main, re-checked by the signer). The two encode the same
 * bytes, so the signer regenerates the mnemonic from a hex-seed import and the
 * resulting envelope is identical either way.
 */
export interface ImportReq extends BaseReq {
  type: 'signer:import';
  mnemonic?: string;
  hexSeed?: string;
  password: string;
}

export interface UnlockReq extends BaseReq {
  type: 'signer:unlock';
  /** Present for a password unlock; omitted when unlocking via `kekHex`. */
  password?: string;
  encrypted: EncryptedSeed;
  /**
   * If the KEK was retrieved from the OS keychain, main passes it here (hex)
   * and `password` is ignored. The signer still re-validates by decrypting.
   */
  kekHex?: string;
  /** When true the signer returns the derived KEK (hex) so main can stash it
   * in the OS keychain. Only honored on a password unlock. */
  wantKek?: boolean;
  autolockMs: number;
}

export interface SignReq extends BaseReq {
  type: 'signer:sign';
  request: SignatureRequest;
  /** Chain id, needed to sign transactions; echoed back unchanged. */
  chainId: number;
}

export interface LockReq extends BaseReq {
  type: 'signer:lock';
}

/** Re-arm the idle autolock timer of an open session with a new bound (main
 * persisted a settings change). No-op success while locked: the new bound is
 * simply passed on the next unlock. Carries no secret. */
export interface SetAutolockReq extends BaseReq {
  type: 'signer:setAutolock';
  autolockMs: number;
}

export interface StatusReq extends BaseReq {
  type: 'signer:status';
}

export interface ShutdownReq extends BaseReq {
  type: 'signer:shutdown';
}

export type SignerRequest =
  CreateReq | ImportReq | UnlockReq | SignReq | LockReq | SetAutolockReq | StatusReq | ShutdownReq;

// ---- Responses (signer -> main) -------------------------------------------

export interface SignerReady {
  type: 'signer:ready';
}

export interface ImportResult {
  address: string;
  encrypted: EncryptedSeed;
}

export interface CreateResult {
  address: string;
  encrypted: EncryptedSeed;
  /**
   * The freshly generated recovery mnemonic, surfaced ONCE so the user can back
   * it up. This is the only time it crosses to main/renderer; it is never
   * persisted in plaintext and the hex seed / secret key never leave the signer.
   */
  mnemonic: string;
}

export interface UnlockResult {
  address: string;
  unlockExpiresAt: number;
  /**
   * Present only when main asked to provision the keychain (import or an
   * explicit opt-in unlock): the freshly derived KEK, hex, for main to store
   * via the KeyVault. Never written to disk in plaintext.
   */
  kekHex?: string;
}

export interface SignerStatus {
  unlocked: boolean;
  address: string | null;
  unlockExpiresAt: number | null;
}

export type SignerOk =
  | { id: number; ok: true; type: 'signer:create'; result: CreateResult }
  | { id: number; ok: true; type: 'signer:import'; result: ImportResult }
  | { id: number; ok: true; type: 'signer:unlock'; result: UnlockResult }
  | { id: number; ok: true; type: 'signer:sign'; result: SignatureResult }
  | { id: number; ok: true; type: 'signer:lock'; result: null }
  | { id: number; ok: true; type: 'signer:setAutolock'; result: null }
  | { id: number; ok: true; type: 'signer:status'; result: SignerStatus }
  | { id: number; ok: true; type: 'signer:shutdown'; result: null };

export interface SignerErr {
  id: number;
  ok: false;
  /** Human-safe error code; never contains key material or the password. */
  error: string;
}

export type SignerResponse = SignerOk | SignerErr;

/** Async lock notification the signer pushes when the autolock timer fires. */
export interface SignerAutoLock {
  type: 'signer:autolock';
}

export type SignerOutbound = SignerReady | SignerResponse | SignerAutoLock;
