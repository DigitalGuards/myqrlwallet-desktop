/**
 * Preload for the native desktop settings panel, the WebContentsView main
 * stacks over the wallet renderer (src/main/settingsView.ts). Runs sandboxed +
 * context-isolated like every other preload, exposing ONLY the narrow
 * `window.settingsBridge` surface over contextBridge. Raw ipcRenderer is never
 * exposed. The native-only personal mark joins a timeout preference,
 * a biometric toggle, data-free maintenance actions, closing the
 * panel, and the trusted-confirmed removal of the active wallet (main draws
 * the gate).
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { Language } from '../shared/language';
import type { MessageKey } from '../shared/i18n';

export type SettingsAction = 'reregister-protocol' | 'open-logs';

export interface DesktopSettings {
  unlockPhrase: string;
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
  randomizeUnlockPhrase: (): Promise<string> =>
    ipcRenderer.invoke('settings:randomizeUnlockPhrase'),
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
