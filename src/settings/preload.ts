/**
 * Preload for the native desktop settings panel, the WebContentsView main
 * stacks over the wallet renderer (src/main/settingsView.ts). Runs sandboxed +
 * context-isolated like every other preload, exposing ONLY the narrow
 * `window.settingsBridge` surface over contextBridge. Raw ipcRenderer is never
 * exposed, and no secret ever crosses here: the settings are a timeout
 * preference, a biometric toggle, data-free maintenance actions, closing the
 * panel, and the trusted-confirmed removal of the active wallet (main draws
 * the gate).
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { Language } from '../shared/language';
import type { MessageKey } from '../shared/i18n';

export type SettingsAction = 'reregister-protocol' | 'open-logs';

export interface DesktopSettings {
  autolockMs: number;
  biometricUnlock: boolean;
}

export interface SettingsCapabilities {
  biometricsAvailable: boolean;
  platform: string;
  appVersion: string;
  /** True when QRL_AUTOLOCK_MS overrides the store (UI disables the control). */
  autolockEnvOverride: boolean;
  /** The autolock actually in force (env > store > default). */
  effectiveAutolockMs: number;
}

export interface SettingsWalletInfo {
  /** The account the destructive Remove action targets (a public address). */
  activeAddress: string | null;
}

export interface SettingsInfo {
  settings: DesktopSettings;
  wallet: SettingsWalletInfo;
  capabilities: SettingsCapabilities;
}

const api = {
  getLanguage: (): Promise<Language> => ipcRenderer.invoke('settings:getLanguage'),
  onLanguageChanged: (callback: (language: Language) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, language: unknown) => {
      // Keep sandboxed preload entries self-contained: shared runtime imports
      // create chunks that the sandbox cannot require.
      if (
        language === 'en' ||
        language === 'de' ||
        language === 'es' ||
        language === 'ru' ||
        language === 'zh-CN'
      )
        callback(language);
    };
    ipcRenderer.on('wallet:languageChanged', listener);
    return () => {
      ipcRenderer.removeListener('wallet:languageChanged', listener);
    };
  },
  /** Current settings + wallet info + platform capability flags. */
  get: (): Promise<SettingsInfo> => ipcRenderer.invoke('settings:get'),
  /** Persist a partial update; returns the stored (clamped) result. */
  set: (patch: Partial<DesktopSettings>): Promise<{ settings: DesktopSettings }> =>
    ipcRenderer.invoke('settings:set', patch),
  /** Run a data-free maintenance action. */
  action: (
    action: SettingsAction,
  ): Promise<{ ok: boolean; error?: string; errorKey?: MessageKey }> =>
    ipcRenderer.invoke('settings:action', { action }),
  /** Remove the ACTIVE wallet from this device. Main draws the trusted
   * confirmation (default Cancel) and rejects with a cancel message when the
   * user declines. Resolves to the self-healed active address afterwards. */
  removeWallet: (): Promise<{ activeAddress: string | null }> =>
    ipcRenderer.invoke('settings:removeWallet'),
  /** Dismiss the panel and hand focus back to the wallet renderer. The panel
   * has no window of its own, so closing is an IPC ask like everything else
   * here. It gates nothing. */
  close: (): Promise<void> => ipcRenderer.invoke('settings:close'),
};

contextBridge.exposeInMainWorld('settingsBridge', api);

// ---- Colour theme (styling only) -------------------------------------------
// Sets data-theme="light" on <html> for the light colour set and removes it for
// dark; the stylesheet keys on that attribute. The resolved theme comes from
// the creation-time argument (first frame), then from main's pull and push.
// Each value is checked against the literal list and anything else is ignored.
// Nothing here is exposed to the page, and a failure leaves the dark set on
// with the bridge above already mounted.
const THEME_ARGUMENT = '--qrl-theme=';
let wantedTheme: 'dark' | 'light' | null = null;
let themeObserver: MutationObserver | null = null;
function paintTheme(): boolean {
  // Null while the preload runs: <html> does not exist yet.
  const root = document.querySelector('html');
  if (!root || wantedTheme === null) return false;
  if (wantedTheme === 'light') root.setAttribute('data-theme', 'light');
  else root.removeAttribute('data-theme');
  return true;
}
function applyTheme(resolved: unknown): void {
  if (resolved !== 'dark' && resolved !== 'light') return;
  wantedTheme = resolved;
  if (paintTheme() || themeObserver) return;
  // The preload runs before <html> exists: paint as soon as the parser adds
  // it, before the page's first script and its first frame.
  const observer = new MutationObserver(() => {
    if (paintTheme()) {
      observer.disconnect();
      themeObserver = null;
    }
  });
  themeObserver = observer;
  observer.observe(document, { childList: true });
}
function resolvedTheme(raw: unknown): unknown {
  return typeof raw === 'object' && raw !== null ? Reflect.get(raw, 'resolved') : undefined;
}
try {
  const argument = process.argv.find((entry) => entry.startsWith(THEME_ARGUMENT));
  if (argument !== undefined) applyTheme(argument.slice(THEME_ARGUMENT.length));
  ipcRenderer.on('wallet:themeChanged', (_event: Electron.IpcRendererEvent, raw: unknown) => {
    applyTheme(resolvedTheme(raw));
  });
  ipcRenderer.invoke('settings:getTheme').then(
    (raw: unknown) => {
      applyTheme(resolvedTheme(raw));
    },
    () => undefined,
  );
} catch {
  // Styling only: the window keeps the dark colour set.
}
