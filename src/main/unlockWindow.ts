/**
 * The desktop unlock window: an app-owned BrowserWindow shown whenever the signer
 * is locked (startup with an existing wallet, signer auto-lock, or an explicit
 * renderer lock). It is NATIVE to the desktop app, not part of the web renderer:
 * the password is collected here and forwarded to the isolated signer over a
 * dedicated IPC surface that ONLY this window may drive.
 *
 * While locked the main wallet window is HIDDEN, so the unlock window is the only
 * thing on screen (a single-window lock screen). The lock cannot be bypassed:
 * dismissing the unlock window while still locked quits the app rather than
 * revealing the wallet behind it.
 */
import path from 'node:path';
import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { AUTOLOCK_MS } from './config';
import {
  getActiveAddress,
  listSeeds,
  readActiveSeed,
  readSeedByAddress,
  setActiveAddress,
} from './seedFile';
import { hardenedWebPreferences } from './security';
import { EVENTS } from '../shared/constants';
import type { EncryptedSeed } from '../shared/protocol';
import type { SignerBridge } from './signerBridge';
import type { KeyVault } from '../keyvault';

export interface UnlockDeps {
  getMainWindow: () => BrowserWindow | null;
  signer: SignerBridge;
  keyVault: KeyVault;
}

let unlockWin: BrowserWindow | null = null;
// Set true the instant a successful unlock asks the window to close, so the
// 'close' handler does not treat that as a user dismissal (which quits).
let unlocked = false;
let ipcRegistered = false;

function notifyMain(deps: UnlockDeps, locked: boolean): void {
  const win = deps.getMainWindow();
  if (win && !win.isDestroyed()) win.webContents.send(EVENTS.LOCK_STATE_CHANGED, locked);
}

function finishUnlock(deps: UnlockDeps): void {
  notifyMain(deps, false);
  unlocked = true;
  // Reveal the main wallet window (hidden while locked) BEFORE closing the
  // unlock window, so a live window always exists (else window-all-closed could
  // quit the app in the gap).
  const main = deps.getMainWindow();
  if (main && !main.isDestroyed()) main.show();
  if (unlockWin && !unlockWin.isDestroyed()) unlockWin.close();
}

/**
 * A renderer-driven unlock succeeded while this native window may be up: tear
 * it down through the same finishUnlock path so the two unlock flows cannot
 * desync (an unlock window lingering over an already-unlocked wallet, whose
 * dismissal would quit the app).
 */
export function notifyUnlockedExternally(deps: UnlockDeps): void {
  if (unlockWin && !unlockWin.isDestroyed() && !unlocked) {
    finishUnlock(deps);
  }
}

/** Resolve which wallet an unlock attempt targets: an explicit address from
 * the picker, else the active wallet. */
async function resolveTarget(address: unknown): Promise<EncryptedSeed | null> {
  if (typeof address === 'string' && address.length > 0) {
    return readSeedByAddress(address);
  }
  return readActiveSeed();
}

/**
 * Register the unlock-window IPC once. Every handler accepts ONLY events whose
 * sender is the live unlock window, so no other web contents can drive unlock.
 */
export function registerUnlockIpc(deps: UnlockDeps): void {
  if (ipcRegistered) return;
  ipcRegistered = true;

  const fromUnlockWindow = (event: IpcMainInvokeEvent): boolean =>
    unlockWin !== null && !unlockWin.isDestroyed() && event.sender === unlockWin.webContents;

  ipcMain.handle('unlock:getInfo', async (event) => {
    if (!fromUnlockWindow(event)) throw new Error('unauthorized');
    const seeds = await listSeeds();
    const wallets = [];
    for (const s of seeds) {
      wallets.push({ address: s.address, keychainBacked: await deps.keyVault.has(s.address) });
    }
    const active = await getActiveAddress();
    return { wallets, active };
  });

  ipcMain.handle('unlock:submit', async (event, arg: unknown) => {
    if (!fromUnlockWindow(event)) throw new Error('unauthorized');
    const { password, address } = (arg ?? {}) as { password?: unknown; address?: unknown };
    if (typeof password !== 'string' || password.length === 0 || password.length > 1024) {
      return { ok: false, error: 'Enter your password.' };
    }
    const encrypted = await resolveTarget(address);
    if (!encrypted) return { ok: false, error: 'No wallet to unlock.' };
    try {
      await deps.signer.unlock({ encrypted, autolockMs: AUTOLOCK_MS, password });
      // Unlocking an account selects it (the picker may have chosen a
      // different wallet than the previously active one).
      await setActiveAddress(encrypted.address);
      finishUnlock(deps);
      return { ok: true };
    } catch {
      // Never surface crypto detail: a failed decrypt reads as a wrong password.
      return { ok: false, error: 'Incorrect password. Please try again.' };
    }
  });

  ipcMain.handle('unlock:biometric', async (event, arg: unknown) => {
    if (!fromUnlockWindow(event)) throw new Error('unauthorized');
    const { address } = (arg ?? {}) as { address?: unknown };
    const encrypted = await resolveTarget(address);
    if (!encrypted) return { ok: false, error: 'No wallet to unlock.' };
    const kekHex = await deps.keyVault.retrieve(encrypted.address);
    if (!kekHex) return { ok: false, error: 'Biometric unlock is unavailable. Use your password.' };
    try {
      await deps.signer.unlock({ encrypted, autolockMs: AUTOLOCK_MS, kekHex });
      await setActiveAddress(encrypted.address);
      finishUnlock(deps);
      return { ok: true };
    } catch {
      return { ok: false, error: 'Biometric unlock failed. Use your password.' };
    }
  });
}

/** Show (or focus) the app-owned unlock window; hide the main window while locked. */
export function showUnlockWindow(deps: UnlockDeps): void {
  // Short-circuit only to an EXISTING, still-locked window. A window mid-close
  // after a successful unlock (unlocked === true) must fall through so a fresh one
  // is built rather than focusing a dying window.
  if (unlockWin && !unlockWin.isDestroyed() && !unlocked) {
    unlockWin.focus();
    return;
  }

  const main = deps.getMainWindow();
  // Snapshot the main window's bounds so the lock screen appears where the wallet
  // was (a full-bleed lock screen, not a small floating dialog).
  const cover = main && !main.isDestroyed() ? main.getBounds() : null;

  // Hide the main window SYNCHRONOUSLY (not deferred to the unlock window's
  // ready-to-show): the signer is already locked, so the wallet must not stay
  // visible during the unlock renderer's paint delay. This is the cardinal
  // "locked => main never visible" invariant and must hold on every autolock.
  if (main && !main.isDestroyed()) main.hide();

  const preload = path.join(__dirname, '../preload/unlock.js');
  unlocked = false;
  // Parentless + non-modal: hiding a modal child's parent is platform-dependent
  // and can orphan/hide the child along with it. Keep the windows independent and
  // rely on the synchronous main.hide() above for the single-window lock screen.
  const win = new BrowserWindow({
    width: cover?.width ?? 1100,
    height: cover?.height ?? 800,
    ...(cover ? { x: cover.x, y: cover.y } : {}),
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    backgroundColor: '#0b0d12',
    title: 'Unlock MyQRLwallet',
    autoHideMenuBar: true,
    webPreferences: hardenedWebPreferences(preload),
  });
  unlockWin = win;

  // Recovery: if the unlock renderer never presents (missing/corrupt asset,
  // crash/OOM before first paint, or a load that hangs), the main window is
  // already hidden and the unlock window would never show, stranding the user
  // alive-but-invisible and locked out of their keys. Fail closed: quit so a
  // relaunch can retry (the encrypted seed is safe on disk; the signer holds
  // nothing). Quitting is also the safe outcome for autolock-walked-away.
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const clearWatchdog = (): void => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = undefined;
  };
  const recover = (reason: string): void => {
    clearWatchdog();
    if (unlocked) return; // a successful unlock already tore this window down
    console.error(
      `[unlock] window failed to present (${reason}); quitting to avoid an invisible lock-out`,
    );
    app.quit();
  };

  win.once('ready-to-show', () => {
    clearWatchdog();
    win.show();
  });
  // Only the MAIN frame failing is a present-failure; a sub-resource (e.g. the
  // logo) failing must NOT tear the window down.
  win.webContents.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
    if (isMainFrame) recover(`did-fail-load ${String(code)} ${desc}`);
  });
  win.webContents.on('render-process-gone', (_e, details) =>
    recover(`render-process-gone ${details.reason}`),
  );
  watchdog = setTimeout(() => recover('watchdog timeout'), 15_000);
  if (typeof watchdog.unref === 'function') watchdog.unref();

  // The lock cannot be bypassed: dismissing the unlock window while still locked
  // quits the app rather than revealing the wallet.
  win.on('close', () => {
    if (!unlocked) app.quit();
  });
  // Only clear the module ref if THIS window is still current; a re-lock during a
  // close may have already replaced it with a fresh window.
  win.on('closed', () => {
    if (unlockWin === win) unlockWin = null;
  });

  void win.loadFile(path.join(__dirname, '../unlock/index.html'));
}
