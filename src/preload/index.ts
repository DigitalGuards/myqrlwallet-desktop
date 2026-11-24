/**
 * Preload bridge. Runs in the renderer's process but in an isolated context
 * (contextIsolation:true) and under the Chromium sandbox (sandbox:true), so it
 * may only `require` electron's allowlisted modules (contextBridge,
 * ipcRenderer) plus a tiny Node subset. That is all we need.
 *
 * HARD RULES (enforced by review, see CLAUDE.md):
 *  - Expose ONLY narrow, named, parameterised async wrappers over
 *    `ipcRenderer.invoke`, event wrappers that strip the event object, and
 *    frozen plain values. Never expose `ipcRenderer` itself, nor a bound
 *    `invoke`, nor `.on/.send/.sendSync`: that would hand the renderer the
 *    ability to call any channel and defeat the per-channel allowlist.
 *  - The one synchronous call (SYNC.GET_THEME) runs here, once, before the
 *    page's first script. Only its validated, frozen result is exposed.
 *  - No key material ever passes through here, in either direction.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { BRIDGE_KEY, EVENTS, IPC, SYNC } from '../shared/constants';
import type { QrlWalletApi, QrlWalletNetwork } from '../shared/bridge';
import type { ThemePreference, ThemeState } from '../shared/theme';

// Replaced by electron-vite with this build's network record, derived from the
// same table main pins (src/main/config.ts networkBuildDefines).
declare const __QRL_WALLET_NETWORK__: QrlWalletNetwork;

// The theme pair, checked against the literal lists here (a shared runtime
// import would add a chunk the sandbox cannot load). Anything else is dropped.
function themeState(raw: unknown): ThemeState | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const theme: unknown = Reflect.get(raw, 'theme');
  const resolved: unknown = Reflect.get(raw, 'resolved');
  const preference: ThemePreference | undefined =
    theme === 'dark' || theme === 'light' || theme === 'system' ? theme : undefined;
  if (preference === undefined || (resolved !== 'dark' && resolved !== 'light')) return undefined;
  return Object.freeze({ theme: preference, resolved });
}

// Main's theme when this document starts, before the page's first script.
// Never throws: a failed or invalid read leaves `theme` out (the renderer then
// keeps its browser behaviour) and the bridge still mounts.
function startTheme(): ThemeState | undefined {
  try {
    return themeState(ipcRenderer.sendSync(SYNC.GET_THEME));
  } catch {
    return undefined;
  }
}
const theme = startTheme();

const api: QrlWalletApi = {
  addressScheme: 'qip55-64',
  // Compatibility metadata, like addressScheme: the network this build was
  // made for. Main enforces the same pins on every RPC call and signature and
  // never reads this value back.
  network: Object.freeze({ ...__QRL_WALLET_NETWORK__ }),
  ...(theme ? { theme } : {}),
  setLanguage: (language) => ipcRenderer.invoke(IPC.SET_LANGUAGE, language),
  setTheme: (next) => ipcRenderer.invoke(IPC.SET_THEME, next),
  // A COMPATIBILITY HINT. It tells a renderer which optional request fields
  // this shell's schemas understand, so a newer renderer can omit a field an
  // older shell would reject. The security control stays the schema: every
  // value this hint describes is validated at the IPC boundary, so a renderer
  // that ignores or forges the hint gains nothing. Frozen because the value is
  // a constant; contextBridge clones it into the renderer anyway.
  features: Object.freeze({ dappGasLimit: true as const }),
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
  onThemeChanged: (cb) => {
    // The event object stays here; only a validated { theme, resolved } pair
    // reaches the renderer callback.
    const listener = (_event: unknown, raw: unknown): void => {
      const state = themeState(raw);
      if (state) cb(state);
    };
    ipcRenderer.on(EVENTS.THEME_CHANGED, listener);
    return () => ipcRenderer.removeListener(EVENTS.THEME_CHANGED, listener);
  },
};

contextBridge.exposeInMainWorld(BRIDGE_KEY, api);
