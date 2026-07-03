/**
 * The native desktop settings window: a second app-owned BrowserWindow
 * following the unlock-window pattern (src/main/unlockWindow.ts) exactly.
 * Main draws it, main owns its state; the wallet renderer can only ASK for it
 * to be shown (IPC.OPEN_DESKTOP_SETTINGS) and can neither read nor write any
 * setting managed here.
 *
 * Lock interaction: while the lock screen owns the display
 * (isUnlockWindowShown()), this window refuses to open and instead focuses the
 * unlock window; it never reveals the hidden main window. Closing it is
 * unrestricted: it gates nothing.
 *
 * Every IPC handler accepts ONLY events whose sender is the live settings
 * window (fromSettingsWindow), then zod-parses its argument. No secrets ever
 * cross this surface: the store holds a timeout preference and a biometric
 * toggle, and the two actions (re-register protocol handler, open logs folder)
 * carry no data.
 */
import path from 'node:path';
import { app, BrowserWindow, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { promises as fs } from 'node:fs';
import { z } from 'zod';
import { logMain, logsDir } from './log';
import { listSeeds } from './seedFile';
import { hardenedWebPreferences } from './security';
import {
  getEffectiveAutolockMs,
  hasAutolockEnvOverride,
  readSettings,
  updateSettings,
  type StoredSettings,
} from './settingsFile';
import { focusUnlockWindow, isUnlockWindowShown } from './unlockWindow';
import { DEFAULT_AUTOLOCK_MS } from '../shared/constants';
import type { SignerBridge } from './signerBridge';
import type { KeyVault } from '../keyvault';

export interface SettingsDeps {
  getMainWindow: () => BrowserWindow | null;
  signer: SignerBridge;
  keyVault: KeyVault;
  /** Re-invoke the qrlconnect:// protocol registration (owned by index.ts). */
  reregisterProtocol: () => boolean;
}

let settingsWin: BrowserWindow | null = null;
let ipcRegistered = false;

/** The stored envelope resolved to the concrete values the UI shows. */
function toUiSettings(stored: StoredSettings): { autolockMs: number; biometricUnlock: boolean } {
  return {
    autolockMs: stored.autolockMs ?? DEFAULT_AUTOLOCK_MS,
    biometricUnlock: stored.biometricUnlock ?? true,
  };
}

const SetSchema = z.strictObject({
  autolockMs: z.number().int().optional(),
  biometricUnlock: z.boolean().optional(),
});

const ActionSchema = z.strictObject({
  action: z.enum(['reregister-protocol', 'open-logs']),
});

/**
 * Register the settings-window IPC once. Every handler accepts ONLY events
 * whose sender is the live settings window, exactly like fromUnlockWindow.
 */
export function registerSettingsIpc(deps: SettingsDeps): void {
  if (ipcRegistered) return;
  ipcRegistered = true;

  const fromSettingsWindow = (event: IpcMainInvokeEvent): boolean =>
    settingsWin !== null && !settingsWin.isDestroyed() && event.sender === settingsWin.webContents;

  ipcMain.handle('settings:get', async (event) => {
    if (!fromSettingsWindow(event)) throw new Error('unauthorized');
    const [stored, biometricsAvailable, effectiveAutolockMs] = await Promise.all([
      readSettings(),
      deps.keyVault.isAvailable(),
      getEffectiveAutolockMs(),
    ]);
    return {
      settings: toUiSettings(stored),
      capabilities: {
        biometricsAvailable,
        platform: process.platform,
        appVersion: app.getVersion(),
        // When the operator set QRL_AUTOLOCK_MS the store is bypassed; the UI
        // disables the control and shows the effective (env) value.
        autolockEnvOverride: hasAutolockEnvOverride(process.env['QRL_AUTOLOCK_MS']),
        effectiveAutolockMs,
      },
    };
  });

  ipcMain.handle('settings:set', async (event, raw: unknown) => {
    if (!fromSettingsWindow(event)) throw new Error('unauthorized');
    const parsed = SetSchema.safeParse(raw);
    if (!parsed.success) throw new Error('invalid settings payload');
    const stored = await updateSettings(parsed.data);
    if (parsed.data.autolockMs !== undefined) {
      // Live re-arm: if a signer session is open, the new bound applies now
      // (the signer no-ops with success while locked). Resolved through the
      // effective order so an env override keeps winning.
      const effective = await getEffectiveAutolockMs();
      await deps.signer
        .setAutolock(effective)
        .catch((err: unknown) =>
          logMain(
            `[settings] autolock re-arm failed: ${err instanceof Error ? err.message : 'error'}`,
          ),
        );
      logMain(
        `[settings] autolock set to ${String(stored.autolockMs)}ms (effective ${String(effective)}ms)`,
      );
    }
    if (parsed.data.biometricUnlock === false) {
      // Turning the preference OFF revokes the stored KEKs: clear the OS
      // keychain entry of every provisioned wallet. Failures are logged, not
      // swallowed silently, and never block persisting the preference.
      const seeds = await listSeeds();
      let cleared = 0;
      for (const seed of seeds) {
        try {
          await deps.keyVault.delete(seed.address);
          cleared += 1;
        } catch (err) {
          logMain(
            `[settings] keychain clear failed for one wallet: ${err instanceof Error ? err.message : 'error'}`,
          );
        }
      }
      logMain(
        `[settings] biometric unlock disabled: cleared ${String(cleared)}/${String(seeds.length)} keychain entries`,
      );
    }
    if (parsed.data.biometricUnlock === true) {
      // Provisioning happens at the next unlock/import, never from here.
      logMain('[settings] biometric unlock enabled (KEK provisions on next unlock)');
    }
    return { settings: toUiSettings(stored) };
  });

  ipcMain.handle('settings:action', async (event, raw: unknown) => {
    if (!fromSettingsWindow(event)) throw new Error('unauthorized');
    const parsed = ActionSchema.safeParse(raw);
    if (!parsed.success) throw new Error('invalid settings action');
    switch (parsed.data.action) {
      case 'reregister-protocol': {
        const ok = deps.reregisterProtocol();
        logMain(`[settings] qrlconnect re-registration: ${ok ? 'ok' : 'FAILED'}`);
        return ok ? { ok: true } : { ok: false, error: 'Registration was refused by the OS.' };
      }
      case 'open-logs': {
        const dir = logsDir();
        // Ensure the folder exists (a fresh install may not have logged yet).
        await fs.mkdir(dir, { recursive: true }).catch(() => undefined);
        const err = await shell.openPath(dir);
        logMain(`[settings] open logs folder: ${err === '' ? 'ok' : 'FAILED'}`);
        return err === '' ? { ok: true } : { ok: false, error: err };
      }
    }
  });
}

/**
 * Show (or focus) the native settings window. Singleton. MUST refuse to open
 * while locked: the unlock window is the only permitted surface, and opening
 * settings must never reveal the hidden main window.
 */
export function showSettingsWindow(deps: SettingsDeps): void {
  if (isUnlockWindowShown()) {
    logMain('[settings] refused to open while locked');
    focusUnlockWindow();
    return;
  }
  if (settingsWin && !settingsWin.isDestroyed()) {
    if (settingsWin.isMinimized()) settingsWin.restore();
    settingsWin.focus();
    return;
  }

  const preload = path.join(__dirname, '../preload/settings.js');
  const main = deps.getMainWindow();
  // Parent to the main window when it is up and visible so the settings window
  // stays associated with the wallet; non-modal (it gates nothing).
  const parent = main && !main.isDestroyed() && main.isVisible() ? main : undefined;
  const win = new BrowserWindow({
    width: 520,
    height: 600,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    backgroundColor: '#0b0d12',
    title: 'MyQRLWallet Settings',
    autoHideMenuBar: true,
    ...(parent ? { parent } : {}),
    webPreferences: hardenedWebPreferences(preload),
  });
  settingsWin = win;

  win.once('ready-to-show', () => win.show());
  // Only clear the module ref if THIS window is still current.
  win.on('closed', () => {
    if (settingsWin === win) settingsWin = null;
  });

  void win.loadFile(path.join(__dirname, '../settings/index.html'));
}
