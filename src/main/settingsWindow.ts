/**
 * The native desktop settings window: a second app-owned BrowserWindow
 * following the unlock-window pattern (src/main/unlockWindow.ts) exactly.
 * Main draws it, main owns its state; the wallet renderer can only ASK for it
 * to be shown (IPC.OPEN_DESKTOP_SETTINGS) and can neither read nor write any
 * setting managed here.
 *
 * Lock interaction: while the lock screen owns the display
 * (isUnlockWindowShown()), this window refuses to open and instead focuses the
 * unlock window; it never reveals the hidden main window. Conversely, when the
 * lock screen takes over, index.ts closes this window (setOnUnlockShown ->
 * closeSettingsWindow): its actions must not be reachable while locked.
 * Closing it is unrestricted: it gates nothing.
 *
 * Every IPC handler accepts ONLY events whose sender is the live settings
 * window (fromSettingsWindow), then zod-parses its argument. No secrets ever
 * cross this surface: the store holds a timeout preference and a biometric
 * toggle, the actions (re-register protocol handler, open logs folder) carry
 * no data, and wallet removal runs the same trusted-confirmed flow as the
 * renderer path (src/main/walletRemoval.ts), parented to this window.
 */
import path from 'node:path';
import { app, BrowserWindow, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { promises as fs } from 'node:fs';
import { z } from 'zod';
import { confirmRemoveWallet } from './confirm';
import { logMain, logsDir } from './log';
import { deleteSeed, getActiveAddress, hasAnySeed, listSeeds, readSeedByAddress } from './seedFile';
import { hardenedWebPreferences } from './security';
import {
  getEffectiveAutolockMs,
  hasAutolockEnvOverride,
  readSettings,
  updateSettings,
  type StoredSettings,
} from './settingsFile';
import { focusUnlockWindow, isUnlockWindowShown } from './unlockWindow';
import { removeWalletFlow } from './walletRemoval';
import { DEFAULT_AUTOLOCK_MS, EVENTS } from '../shared/constants';
import type { SignerBridge } from './signerBridge';
import type { KeyVault } from '../keyvault';

export interface SettingsDeps {
  getMainWindow: () => BrowserWindow | null;
  signer: SignerBridge;
  keyVault: KeyVault;
  /** Re-invoke the qrlconnect:// protocol registration (owned by index.ts). */
  reregisterProtocol: () => boolean;
  /** Raise the native unlock window (removal of the unlocked account). */
  showUnlock: () => void;
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
    const [stored, biometricsAvailable, effectiveAutolockMs, activeAddress] = await Promise.all([
      readSettings(),
      deps.keyVault.isAvailable(),
      getEffectiveAutolockMs(),
      getActiveAddress(),
    ]);
    return {
      settings: toUiSettings(stored),
      // Which account the destructive Remove action targets. A public address,
      // not a secret; the wallet renderer displays it freely.
      wallet: { activeAddress },
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
      // swallowed silently, and never block persisting the preference. The
      // sweep is defense-in-depth: every unlock path also checks the
      // preference itself, so a failed listing (listSeeds throws on real I/O
      // errors) degrades to KEK bytes lingering in the vault, not to a
      // usable biometric unlock.
      let seeds: Awaited<ReturnType<typeof listSeeds>> = [];
      try {
        seeds = await listSeeds();
      } catch (err) {
        logMain(
          `[settings] keychain sweep skipped: seed listing failed (${err instanceof Error ? err.message : 'error'})`,
        );
      }
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

  // Destructive removal of the ACTIVE wallet, from the settings window. Runs
  // the exact flow the renderer's IPC.REMOVE_WALLET runs (same trusted
  // main-drawn confirmation, default Cancel), parented to this window. The
  // wallet renderer had no hand in the removal, so it is reloaded afterwards:
  // its boot-time hydration reconciles the account list against the signer's
  // seed files. If the removed account owned the open session, the flow raises
  // the unlock window, which closes this window via the onUnlockShown hook.
  ipcMain.handle('settings:removeWallet', async (event) => {
    if (!fromSettingsWindow(event)) throw new Error('unauthorized');
    const win = settingsWin;
    if (!win || win.isDestroyed()) throw new Error('unauthorized');
    await removeWalletFlow({
      signer: deps.signer,
      keyVault: deps.keyVault,
      seeds: {
        readByAddress: readSeedByAddress,
        getActive: getActiveAddress,
        delete: deleteSeed,
        hasAny: hasAnySeed,
      },
      confirm: (address) => confirmRemoveWallet(win, address),
      emitLockState: (locked) => {
        const main = deps.getMainWindow();
        if (main && !main.isDestroyed()) {
          main.webContents.send(EVENTS.LOCK_STATE_CHANGED, locked);
        }
      },
      showUnlock: deps.showUnlock,
      warn: (message) => logMain(`[settings] ${message}`),
    });
    logMain('[settings] wallet removed via settings window');
    const main = deps.getMainWindow();
    if (main && !main.isDestroyed()) main.webContents.reload();
    // The (self-healed) active address after the removal, so the UI can
    // refresh without a second round-trip.
    return { activeAddress: await getActiveAddress() };
  });
}

/** Close the settings window (lock screen takeover, or a dApp URI arriving
 * that needs the wallet surface back). Safe to call anytime; the window's
 * closed handler restores the wallet window when appropriate. */
export function closeSettingsWindow(): void {
  // destroy(), not close(): a modal confirm dialog attached to this window can
  // defer close() on some platforms, which would leave the remove-wallet
  // confirmation approvable while the lock screen owns the display. destroy()
  // tears down unconditionally; an attached dialog resolves as Cancel.
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.destroy();
}

/** True while the settings window is the visible app surface (the wallet
 * window is hidden behind it). */
export function isSettingsWindowShown(): boolean {
  // Visibility, not mere existence: a window mid-load (or hung before
  // ready-to-show) must not swallow focus meant for the visible wallet.
  return settingsWin !== null && !settingsWin.isDestroyed() && settingsWin.isVisible();
}

/** Bring the settings window to the front (duplicate app launches while it is
 * the visible surface). */
export function focusSettingsWindow(): void {
  if (settingsWin && !settingsWin.isDestroyed()) {
    if (settingsWin.isMinimized()) settingsWin.restore();
    settingsWin.focus();
  }
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
  // The unlock-window takeover pattern: snapshot the wallet window's bounds so
  // settings appears exactly where the wallet is (a full-bleed screen of the
  // app, not a small floating dialog stacked over it), then hide the wallet
  // underneath once settings has painted. Parentless + non-modal like the
  // unlock window: hiding a modal child's parent is platform-dependent.
  const cover = main && !main.isDestroyed() ? main.getBounds() : null;
  const win = new BrowserWindow({
    width: cover?.width ?? 900,
    height: cover?.height ?? 720,
    ...(cover ? { x: cover.x, y: cover.y } : {}),
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    // Pre-paint color = the design-system canvas (--background, #020817) so
    // the first frame matches settings.css instead of flashing a shade off.
    backgroundColor: '#020817',
    title: 'MyQRLWallet Settings',
    autoHideMenuBar: true,
    webPreferences: hardenedWebPreferences(preload),
  });
  settingsWin = win;

  // Present-failure recovery: settings gates nothing, so a renderer that
  // cannot present is simply destroyed. The wallet window is untouched
  // (hiding happens only inside ready-to-show), so no zero-visible-window
  // state is reachable, and retrying the menu item builds a fresh window.
  const watchdog = setTimeout(() => {
    if (settingsWin === win && !win.isDestroyed() && !win.isVisible()) {
      logMain('[settings] renderer never presented within 10s; destroying');
      win.destroy();
    }
  }, 10_000);
  win.webContents.once('did-fail-load', (_event, code, description) => {
    logMain(`[settings] load failed (${String(code)} ${description}); destroying`);
    if (!win.isDestroyed()) win.destroy();
  });
  win.webContents.once('render-process-gone', (_event, details) => {
    logMain(`[settings] renderer gone (${details.reason}); destroying`);
    if (!win.isDestroyed()) win.destroy();
  });
  win.once('ready-to-show', () => {
    clearTimeout(watchdog);
    // Show first, hide second: settings covers the wallet exactly, so the
    // swap underneath is invisible and the app reads as ONE surface that
    // switched to its settings screen.
    win.show();
    const m = deps.getMainWindow();
    if (m && !m.isDestroyed()) m.hide();
  });
  win.on('closed', () => {
    clearTimeout(watchdog);
    // Only clear the module ref if THIS window is still current.
    if (settingsWin === win) settingsWin = null;
    // Restore the wallet window, UNLESS the lock screen owns the display:
    // settings may have been closed BY the unlock takeover (setOnUnlockShown),
    // and revealing the hidden wallet while locked would break the
    // single-window lock invariant. finishUnlock re-shows it after a real
    // unlock. Skip when something else (URI delivery) already restored it.
    if (isUnlockWindowShown()) return;
    const m = deps.getMainWindow();
    if (m && !m.isDestroyed() && !m.isVisible()) {
      m.show();
      m.focus();
    }
  });

  void win.loadFile(path.join(__dirname, '../settings/index.html'));
}
