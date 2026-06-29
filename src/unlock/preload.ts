/**
 * Preload for the desktop unlock window. Runs sandboxed + context-isolated like
 * the main window's preload, exposing ONLY a narrow unlock surface over
 * contextBridge. No key material crosses here: the password is sent to main,
 * which forwards it to the isolated signer. Raw ipcRenderer is never exposed.
 */
import { contextBridge, ipcRenderer } from 'electron';

const api = {
  /** Wallet address + whether an OS-keychain (Touch ID) unlock is available. */
  getInfo: (): Promise<{ address: string | null; keychainBacked: boolean }> =>
    ipcRenderer.invoke('unlock:getInfo'),
  /** Attempt a password unlock. Resolves `{ ok }` so the UI shows errors inline. */
  submit: (password: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('unlock:submit', password),
  /** Attempt an OS-keychain (Touch ID / device) unlock. */
  biometric: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('unlock:biometric'),
};

contextBridge.exposeInMainWorld('unlockBridge', api);
