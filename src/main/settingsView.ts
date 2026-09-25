/**
 * The native desktop settings surface: a `WebContentsView` attached to the
 * wallet window and stacked above the wallet renderer, sized to the window's
 * content area. It is ONE window with a settings panel over it; the app keeps
 * a single title, a single taskbar entry, and stays resizable.
 *
 * The trust boundary is the same one the previous separate settings window
 * had, and none of it depends on being a window:
 *   - its own web contents with the same hardenedWebPreferences and its own
 *     preload, exposing only `window.settingsBridge`;
 *   - the same no-network meta CSP (src/settings/index.html);
 *   - every IPC handler gated on a live-sender check (fromSettingsView: the
 *     event sender must BE this view's web contents) plus a zod-strict parse;
 *   - no data path between the wallet renderer and this view. The renderer can
 *     only ASK main to show the panel (IPC.OPEN_DESKTOP_SETTINGS, itself
 *     sender-gated) and can neither read nor write any setting managed here.
 *
 * Lock interaction: while the lock screen owns the display
 * (isUnlockWindowShown()), the panel refuses to open and the unlock window is
 * focused instead; it never touches (or reveals) the hidden wallet window.
 * Conversely, when the lock screen takes over, index.ts removes and destroys
 * this view through the setOnUnlockShown hook, so no settings action stays
 * reachable while locked. Closing the panel only ever removes a view from a
 * window that is already on screen, so it can never reveal a wallet window
 * that the lock hid.
 *
 * No secrets cross this surface: the store holds a timeout preference and a
 * biometric toggle, the actions (re-register protocol handler, open logs
 * folder) carry no data, and wallet removal runs the same trusted-confirmed
 * flow as the renderer path (src/main/walletRemoval.ts), now parented to the
 * wallet window because the panel has no window of its own.
 */
import path from 'node:path';
import {
  app,
  type BrowserWindow,
  ipcMain,
  shell,
  WebContentsView,
  type IpcMainInvokeEvent,
} from 'electron';
import { promises as fs } from 'node:fs';
import { z } from 'zod';
import { confirmRemoveWallet } from './confirm';
import { logMain, logsDir } from './log';
import { deleteSeed, getActiveAddress, hasAnySeed, listSeeds, readSeedByAddress } from './seedFile';
import { hardenedWebPreferences } from './security';
import {
  isRemovalStillAuthorized,
  resolveOpenAction,
  settingsViewBounds,
  shouldRestoreWalletFocus,
} from './settingsViewPolicy';
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

/** The live view, from creation until teardown (attached or still loading). */
let settingsView: WebContentsView | null = null;
/** The window the live view is ATTACHED to; null while it is still loading. */
let hostWindow: BrowserWindow | null = null;
/** Unsubscribes for the host window's re-layout and focus listeners. */
let hostTeardown: (() => void)[] = [];
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

/** Lay the view over the whole content area of its host window. */
function layoutView(win: BrowserWindow, view: WebContentsView): void {
  const [width, height] = win.getContentSize();
  view.setBounds(settingsViewBounds(width ?? 0, height ?? 0));
}

/**
 * Register the settings IPC once. Every handler accepts ONLY events whose
 * sender is the live settings view's web contents, exactly like the unlock
 * window's fromUnlockWindow check.
 */
export function registerSettingsIpc(deps: SettingsDeps): void {
  if (ipcRegistered) return;
  ipcRegistered = true;

  const fromSettingsView = (event: IpcMainInvokeEvent): boolean =>
    settingsView !== null &&
    !settingsView.webContents.isDestroyed() &&
    event.sender === settingsView.webContents;

  ipcMain.handle('settings:get', async (event) => {
    if (!fromSettingsView(event)) throw new Error('unauthorized');
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
    if (!fromSettingsView(event)) throw new Error('unauthorized');
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
      // errors) leaves KEK bytes lingering in the vault while biometric
      // unlock stays refused.
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
    if (!fromSettingsView(event)) throw new Error('unauthorized');
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

  // The panel's own way out (the Back control and the Escape key). It gates
  // nothing, so it is unrestricted beyond the live-sender check.
  ipcMain.handle('settings:close', (event) => {
    if (!fromSettingsView(event)) throw new Error('unauthorized');
    closeSettingsView();
  });

  // Destructive removal of the ACTIVE wallet, from the settings panel. Runs
  // the exact flow the renderer's IPC.REMOVE_WALLET runs (same trusted
  // main-drawn confirmation, default Cancel), now parented to the wallet
  // window because the panel has no window of its own. The wallet renderer had
  // no hand in the removal, so it is reloaded afterwards: its boot-time
  // hydration reconciles the account list against the signer's seed files. If
  // the removed account owned the open session, the flow raises the unlock
  // window, which tears this view down via the onUnlockShown hook.
  ipcMain.handle('settings:removeWallet', async (event) => {
    if (!fromSettingsView(event)) throw new Error('unauthorized');
    const view = settingsView;
    const win = deps.getMainWindow();
    if (!view || !win || win.isDestroyed()) throw new Error('unauthorized');
    await removeWalletFlow({
      signer: deps.signer,
      keyVault: deps.keyVault,
      seeds: {
        readByAddress: readSeedByAddress,
        getActive: getActiveAddress,
        delete: deleteSeed,
        hasAny: hasAnySeed,
      },
      confirm: async (address) => {
        const approved = await confirmRemoveWallet(win, address);
        // The dialog is parented to the wallet window, so it outlives the
        // view that started the flow: re-check that the panel is still the
        // one on screen and that the lock screen has not taken over while the
        // dialog was open. A stale or locked state reads as a cancel.
        const allowed = isRemovalStillAuthorized({
          approved,
          viewIsCurrent: settingsView === view,
          locked: isUnlockWindowShown(),
        });
        if (approved && !allowed) {
          logMain('[settings] removal abandoned: the settings panel was torn down mid-dialog');
        }
        return allowed;
      },
      emitLockState: (locked) => {
        const main = deps.getMainWindow();
        if (main && !main.isDestroyed()) {
          main.webContents.send(EVENTS.LOCK_STATE_CHANGED, locked);
        }
      },
      showUnlock: deps.showUnlock,
      warn: (message) => logMain(`[settings] ${message}`),
    });
    logMain('[settings] wallet removed via settings panel');
    const main = deps.getMainWindow();
    if (main && !main.isDestroyed()) main.webContents.reload();
    // The (self-healed) active address after the removal, so the UI can
    // refresh without a second round-trip.
    return { activeAddress: await getActiveAddress() };
  });
}

/**
 * Remove the settings view from its window and destroy its web contents.
 * Called by the Back control, by the lock takeover (setOnUnlockShown), by a
 * qrlconnect:// delivery, and by a dApp attention request. Safe to call
 * anytime, including while the view is still loading.
 */
export function closeSettingsView(): void {
  const view = settingsView;
  const win = hostWindow;
  settingsView = null;
  hostWindow = null;
  // Unconditional: these are plain emitter unsubscribes, and they must also run
  // for a view that was never attached (hostWindow still null).
  for (const off of hostTeardown) off();
  hostTeardown = [];
  if (!view) return;
  if (win && !win.isDestroyed()) {
    win.contentView.removeChildView(view);
    // Hand keyboard focus back to the wallet renderer, but never in a way
    // that could raise a window the lock screen hid: focusing a hidden
    // window's web contents can surface it on some platforms.
    if (
      shouldRestoreWalletFocus({ locked: isUnlockWindowShown(), windowVisible: win.isVisible() }) &&
      !win.webContents.isDestroyed()
    ) {
      win.webContents.focus();
    }
  }
  if (!view.webContents.isDestroyed()) view.webContents.close();
}

/**
 * True while the settings panel is on screen over the wallet renderer. A view
 * that is still loading (not attached yet) does not count: it must not swallow
 * focus meant for the visible wallet.
 */
export function isSettingsViewShown(): boolean {
  return (
    settingsView !== null &&
    hostWindow !== null &&
    !hostWindow.isDestroyed() &&
    hostWindow.isVisible()
  );
}

/** Put keyboard focus back into the settings panel (a second open request, or
 * a duplicate app launch while it is the surface in use). */
export function focusSettingsView(): void {
  const win = hostWindow;
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
  const view = settingsView;
  if (view && !view.webContents.isDestroyed()) view.webContents.focus();
}

/**
 * Show (or focus) the settings panel inside the wallet window. Singleton.
 * MUST refuse while locked: the unlock window is the only permitted surface,
 * and opening settings must never touch the hidden wallet window.
 */
export function showSettingsView(deps: SettingsDeps): void {
  const win = deps.getMainWindow();
  const action = resolveOpenAction({
    locked: isUnlockWindowShown(),
    hasWalletWindow: win !== null && !win.isDestroyed(),
    hasLiveView: settingsView !== null,
  });
  if (action === 'refuse-locked') {
    logMain('[settings] refused to open while locked');
    focusUnlockWindow();
    return;
  }
  if (action === 'refuse-no-window') {
    logMain('[settings] refused to open: no wallet window');
    return;
  }
  if (action === 'focus-existing') {
    focusSettingsView();
    return;
  }
  if (!win) return; // resolveOpenAction already excluded this; narrowing only.

  const preload = path.join(__dirname, '../preload/settings.js');
  const view = new WebContentsView({ webPreferences: hardenedWebPreferences(preload) });
  settingsView = view;
  // Pre-paint color = the design-system canvas (--background, #080c16) so the
  // first frame matches settings.css exactly.
  view.setBackgroundColor('#080c16');

  // Present-failure watchdog: settings gates nothing, so a view that cannot
  // present is simply destroyed and the wallet stays usable. Attaching only
  // happens after the document loads, so a failed load never covers the
  // wallet with a blank panel, and retrying the menu entry builds a fresh one.
  const watchdog = setTimeout(() => {
    if (settingsView === view && hostWindow === null) {
      logMain('[settings] panel never loaded within 10s; destroying');
      closeSettingsView();
    }
  }, 10_000);
  if (typeof watchdog.unref === 'function') watchdog.unref();

  const destroy = (reason: string): void => {
    clearTimeout(watchdog);
    if (settingsView !== view) return; // already replaced or torn down
    logMain(`[settings] ${reason}; destroying panel`);
    closeSettingsView();
  };
  view.webContents.on('did-fail-load', (_e, code, description, _url, isMainFrame) => {
    // Only the MAIN frame failing is a present failure; a sub-resource (the
    // logo, a font) failing must not tear the panel down.
    if (isMainFrame) destroy(`load failed (${String(code)} ${description})`);
  });
  view.webContents.on('render-process-gone', (_e, details) =>
    destroy(`renderer gone (${details.reason})`),
  );
  view.webContents.once('did-finish-load', () => {
    clearTimeout(watchdog);
    if (settingsView !== view) return;
    if (win.isDestroyed()) {
      closeSettingsView();
      return;
    }
    // A lock that landed during the load already ran the teardown hook, but
    // this view was not attached yet, so re-check before covering the window.
    if (isUnlockWindowShown()) {
      logMain('[settings] panel loaded after a lock took over; discarding');
      closeSettingsView();
      return;
    }
    win.contentView.addChildView(view);
    hostWindow = win;
    layoutView(win, view);
    const relayout = (): void => {
      if (settingsView === view && !win.isDestroyed()) layoutView(win, view);
    };
    // Keyboard focus moves into the panel, and stays there whenever the window
    // is re-focused (alt-tab): the wallet renderer is covered, so focus landing
    // on it would be focus on something the user cannot see. Tab traversal does
    // not cross web contents, so it cannot reach the covered renderer either.
    const keepFocus = (): void => {
      if (settingsView === view && !view.webContents.isDestroyed()) view.webContents.focus();
    };
    win.on('resize', relayout);
    win.on('enter-full-screen', relayout);
    win.on('leave-full-screen', relayout);
    win.on('focus', keepFocus);
    hostTeardown.push(
      () => win.off('resize', relayout),
      () => win.off('enter-full-screen', relayout),
      () => win.off('leave-full-screen', relayout),
      () => win.off('focus', keepFocus),
    );
    if (!win.isFocused()) win.focus();
    keepFocus();
    logMain('[settings] panel opened in the wallet window');
  });
  // The window going away takes the panel with it. Registered before the load
  // so it also covers a view that never finished loading, and unsubscribed on
  // teardown so repeated open/close cycles cannot pile listeners on the window.
  const onWindowClosed = (): void => {
    if (settingsView === view) closeSettingsView();
  };
  win.once('closed', onWindowClosed);
  hostTeardown = [() => win.off('closed', onWindowClosed)];

  void view.webContents.loadFile(path.join(__dirname, '../settings/index.html'));
}
