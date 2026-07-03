/**
 * Preload for the native desktop settings window. Runs sandboxed +
 * context-isolated like every other preload, exposing ONLY the narrow
 * `window.settingsBridge` surface over contextBridge. Raw ipcRenderer is never
 * exposed, and no secret ever crosses here: the settings are a timeout
 * preference, a biometric toggle, data-free maintenance actions, and the
 * trusted-confirmed removal of the active wallet (main draws the gate).
 */
import { contextBridge, ipcRenderer } from 'electron';

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
  /** Current settings + wallet info + platform capability flags. */
  get: (): Promise<SettingsInfo> => ipcRenderer.invoke('settings:get'),
  /** Persist a partial update; returns the stored (clamped) result. */
  set: (patch: Partial<DesktopSettings>): Promise<{ settings: DesktopSettings }> =>
    ipcRenderer.invoke('settings:set', patch),
  /** Run a data-free maintenance action. */
  action: (action: SettingsAction): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('settings:action', { action }),
  /** Remove the ACTIVE wallet from this device. Main draws the trusted
   * confirmation (default Cancel) and rejects with a cancel message when the
   * user declines. Resolves to the self-healed active address afterwards. */
  removeWallet: (): Promise<{ activeAddress: string | null }> =>
    ipcRenderer.invoke('settings:removeWallet'),
};

contextBridge.exposeInMainWorld('settingsBridge', api);
