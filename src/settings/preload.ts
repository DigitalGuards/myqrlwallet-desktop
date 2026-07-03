/**
 * Preload for the native desktop settings window. Runs sandboxed +
 * context-isolated like every other preload, exposing ONLY the narrow
 * `window.settingsBridge` surface over contextBridge. Raw ipcRenderer is never
 * exposed, and no secret ever crosses here: the settings are a timeout
 * preference, a biometric toggle, and two data-free maintenance actions.
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

export interface SettingsInfo {
  settings: DesktopSettings;
  capabilities: SettingsCapabilities;
}

const api = {
  /** Current settings + platform capability flags. */
  get: (): Promise<SettingsInfo> => ipcRenderer.invoke('settings:get'),
  /** Persist a partial update; returns the stored (clamped) result. */
  set: (patch: Partial<DesktopSettings>): Promise<{ settings: DesktopSettings }> =>
    ipcRenderer.invoke('settings:set', patch),
  /** Run a data-free maintenance action. */
  action: (action: SettingsAction): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('settings:action', { action }),
};

contextBridge.exposeInMainWorld('settingsBridge', api);
