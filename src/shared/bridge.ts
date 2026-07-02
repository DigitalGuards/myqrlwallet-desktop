/**
 * The typed surface the preload mounts at `window.qrlWallet`.
 *
 * This is the COMPLETE set of capabilities the renderer (the reused
 * myqrlwallet-frontend) is given. There is no
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
  CreateWalletRequest,
  CreateWalletResult,
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
  /** Destructively remove the wallet from this device: deletes the encrypted
   * seed and clears the keychain entry. Requires re-import. Returns the
   * post-wipe status (hasWallet === false). */
  removeWallet(): Promise<WalletStatus>;
  getStatus(): Promise<WalletStatus>;

  // ---- provisioning -------------------------------------------------------
  hasWallet(): Promise<boolean>;
  /** Generate a fresh wallet inside the signer; returns the one-time backup
   * mnemonic plus the unlocked status. The hex seed never enters the renderer. */
  createWallet(req: CreateWalletRequest): Promise<CreateWalletResult>;
  importWallet(req: ImportWalletRequest): Promise<WalletStatus>;

  // ---- broadcast ----------------------------------------------------------
  sendRawTransaction(req: SendRawTransactionRequest): Promise<{ transactionHash: string }>;

  // ---- dApp connect (desktop ingress + attention) --------------------------
  /** Ask main to surface the window because a dApp request needs the user
   * (taskbar flash / dock bounce; never steals focus). Rate-limited in main. */
  dappRequestAttention(): Promise<void>;

  // ---- events -------------------------------------------------------------
  /** Subscribe to lock-state changes (e.g. autolock). Returns an unsubscribe. */
  onLockStateChanged(cb: (locked: boolean) => void): () => void;
  /** Subscribe to qrlconnect:// URIs arriving via the OS protocol handler.
   * The URI is shape-validated by main but otherwise raw: the renderer's
   * dApp-connect stack parses it behind its consent modal. Returns an
   * unsubscribe. */
  onDAppConnectUri(cb: (uri: string) => void): () => void;
}

declare global {
  interface Window {
    qrlWallet: QrlWalletApi;
  }
}
