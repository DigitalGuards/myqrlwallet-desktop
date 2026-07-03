/**
 * Preload bridge. Runs in the renderer's process but in an isolated context
 * (contextIsolation:true) and under the Chromium sandbox (sandbox:true), so it
 * may only `require` electron's allowlisted modules (contextBridge,
 * ipcRenderer) plus a tiny Node subset. That is all we need.
 *
 * HARD RULES (enforced by review, see CLAUDE.md):
 *  - Expose ONLY narrow, named, parameterised async wrappers over
 *    `ipcRenderer.invoke`. Never expose `ipcRenderer` itself, nor a bound
 *    `invoke`, nor `.on/.send`: that would hand the renderer the ability to
 *    call any channel and defeat the per-channel allowlist.
 *  - No key material ever passes through here, in either direction.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { BRIDGE_KEY, EVENTS, IPC } from '../shared/constants';
import type { QrlWalletApi } from '../shared/bridge';

const api: QrlWalletApi = {
  getBalance: (req) => ipcRenderer.invoke(IPC.GET_BALANCE, req),
  buildTransaction: (req) => ipcRenderer.invoke(IPC.BUILD_TRANSACTION, req),
  requestSignature: (req) => ipcRenderer.invoke(IPC.REQUEST_SIGNATURE, req),
  unlock: (req) => ipcRenderer.invoke(IPC.UNLOCK, req),
  lock: () => ipcRenderer.invoke(IPC.LOCK),
  removeWallet: (req) => ipcRenderer.invoke(IPC.REMOVE_WALLET, req),
  getStatus: () => ipcRenderer.invoke(IPC.GET_STATUS),
  listWallets: () => ipcRenderer.invoke(IPC.LIST_WALLETS),
  setActiveWallet: (req) => ipcRenderer.invoke(IPC.SET_ACTIVE_WALLET, req),
  hasWallet: () => ipcRenderer.invoke(IPC.HAS_WALLET),
  createWallet: (req) => ipcRenderer.invoke(IPC.CREATE_WALLET, req),
  importWallet: (req) => ipcRenderer.invoke(IPC.IMPORT_WALLET, req),
  sendRawTransaction: (req) => ipcRenderer.invoke(IPC.SEND_RAW_TRANSACTION, req),
  dappRequestAttention: () => ipcRenderer.invoke(IPC.DAPP_REQUEST_ATTENTION),
  openDesktopSettings: () => ipcRenderer.invoke(IPC.OPEN_DESKTOP_SETTINGS),
  onLockStateChanged: (cb) => {
    // Wrap the callback in a closure rather than handing out ipcRenderer.on.
    const listener = (_event: unknown, locked: boolean): void => cb(locked);
    ipcRenderer.on(EVENTS.LOCK_STATE_CHANGED, listener);
    return () => ipcRenderer.removeListener(EVENTS.LOCK_STATE_CHANGED, listener);
  },
  onDAppConnectUri: (cb) => {
    const listener = (_event: unknown, uri: string): void => {
      // Belt-and-braces: main already shape-validated, but a string check
      // here keeps a malformed payload from reaching the renderer callback.
      if (typeof uri === 'string') cb(uri);
    };
    ipcRenderer.on(EVENTS.DAPP_CONNECT_URI, listener);
    return () => ipcRenderer.removeListener(EVENTS.DAPP_CONNECT_URI, listener);
  },
};

contextBridge.exposeInMainWorld(BRIDGE_KEY, api);
