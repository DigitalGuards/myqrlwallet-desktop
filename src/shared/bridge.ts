/**
 * The typed surface the preload mounts at `window.qrlWallet`.
 *
 * This is the COMPLETE set of capabilities a renderer (the reused
 * myqrlwallet-frontend, or the bundled demo renderer) is given. There is no
 * raw `ipcRenderer`, no `require`, no Node access: a fully compromised renderer
 * can do nothing here that these methods do not explicitly permit, and none of
 * them can return key material.
 *
 * The four spend-path methods named in the build brief are `getBalance`,
 * `buildTransaction`, `requestSignature` and `unlock`; the remainder are the
 * minimal lifecycle calls a working wallet needs (provision, status, lock).
 */
import type {
  BalanceResult,
  BuildTransactionRequest,
  GetBalanceRequest,
  ImportWalletRequest,
  SendRawTransactionRequest,
  SignatureRequest,
  SignatureResult,
  UnlockRequest,
  UnsignedTransaction,
  WalletStatus,
} from './schemas';

export interface QrlWalletApi {
  // ---- read-only ----------------------------------------------------------
  getBalance(req: GetBalanceRequest): Promise<BalanceResult>;

  // ---- transaction assembly (no signing) ----------------------------------
  buildTransaction(req: BuildTransactionRequest): Promise<UnsignedTransaction>;

  // ---- spend path: confirm in a trusted modal, then sign in the signer ----
  requestSignature(req: SignatureRequest): Promise<SignatureResult>;

  // ---- session ------------------------------------------------------------
  /** Open a session. Omit `password` to unlock via the OS keychain (macOS). */
  unlock(req: UnlockRequest): Promise<WalletStatus>;
  lock(): Promise<WalletStatus>;
  getStatus(): Promise<WalletStatus>;

  // ---- provisioning -------------------------------------------------------
  hasWallet(): Promise<boolean>;
  importWallet(req: ImportWalletRequest): Promise<WalletStatus>;

  // ---- broadcast ----------------------------------------------------------
  sendRawTransaction(req: SendRawTransactionRequest): Promise<{ transactionHash: string }>;

  // ---- events -------------------------------------------------------------
  /** Subscribe to lock-state changes (e.g. autolock). Returns an unsubscribe. */
  onLockStateChanged(cb: (locked: boolean) => void): () => void;
}

declare global {
  interface Window {
    qrlWallet: QrlWalletApi;
  }
}
