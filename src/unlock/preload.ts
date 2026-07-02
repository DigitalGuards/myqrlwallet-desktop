/**
 * Preload for the desktop unlock window. Runs sandboxed + context-isolated like
 * the main window's preload, exposing ONLY a narrow unlock surface over
 * contextBridge. No key material crosses here: the password is sent to main,
 * which forwards it to the isolated signer. Raw ipcRenderer is never exposed.
 */
import { contextBridge, ipcRenderer } from 'electron';

export interface UnlockWalletInfo {
  address: string;
  keychainBacked: boolean;
}

const api = {
  /** Every wallet on this device + the active one (drives the account picker). */
  getInfo: (): Promise<{ wallets: UnlockWalletInfo[]; active: string | null }> =>
    ipcRenderer.invoke('unlock:getInfo'),
  /** Attempt a password unlock of `address` (or the active wallet when omitted).
   * Resolves `{ ok }` so the UI shows errors inline. */
  submit: (password: string, address?: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('unlock:submit', { password, address }),
  /** Attempt an OS-keychain (Touch ID / device) unlock of `address`. */
  biometric: (address?: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('unlock:biometric', { address }),
};

contextBridge.exposeInMainWorld('unlockBridge', api);
