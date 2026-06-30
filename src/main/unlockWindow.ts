/**
 * The desktop unlock window: a modal, app-owned BrowserWindow shown whenever the
 * signer is locked (startup with an existing wallet, signer auto-lock, or an
 * explicit renderer lock). It is NATIVE to the desktop app, not part of the web
 * renderer: the password is collected here and forwarded to the isolated signer
 * over a dedicated IPC surface that ONLY this window may drive.
 *
 * The lock cannot be bypassed: dismissing the window while still locked quits
 * the app rather than revealing the wallet behind it.
 */
import path from 'node:path';
import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { AUTOLOCK_MS } from './config';
import { hasSeed, readSeed } from './seedFile';
import { hardenedWebPreferences } from './security';
import { EVENTS } from '../shared/constants';
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

/** True while the unlock window is open and the wallet is still locked. */
export function isUnlockActive(): boolean {
  return unlockWin !== null && !unlockWin.isDestroyed() && !unlocked;
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
    const seed = (await hasSeed()) ? await readSeed() : null;
    const address = seed?.address ?? null;
    const keychainBacked = address ? await deps.keyVault.has(address) : false;
    return { address, keychainBacked };
  });

  ipcMain.handle('unlock:submit', async (event, password: unknown) => {
    if (!fromUnlockWindow(event)) throw new Error('unauthorized');
    if (typeof password !== 'string' || password.length === 0 || password.length > 1024) {
      return { ok: false, error: 'Enter your password.' };
    }
    const encrypted = await readSeed();
    if (!encrypted) return { ok: false, error: 'No wallet to unlock.' };
    try {
      await deps.signer.unlock({ encrypted, autolockMs: AUTOLOCK_MS, password });
      finishUnlock(deps);
      return { ok: true };
    } catch {
      // Never surface crypto detail: a failed decrypt reads as a wrong password.
      return { ok: false, error: 'Incorrect password. Please try again.' };
    }
  });

  ipcMain.handle('unlock:biometric', async (event) => {
    if (!fromUnlockWindow(event)) throw new Error('unauthorized');
    const encrypted = await readSeed();
    if (!encrypted) return { ok: false, error: 'No wallet to unlock.' };
    const kekHex = await deps.keyVault.retrieve(encrypted.address);
    if (!kekHex) return { ok: false, error: 'Biometric unlock is unavailable. Use your password.' };
    try {
      await deps.signer.unlock({ encrypted, autolockMs: AUTOLOCK_MS, kekHex });
      finishUnlock(deps);
      return { ok: true };
    } catch {
      return { ok: false, error: 'Biometric unlock failed. Use your password.' };
    }
  });
}

/** Show (or focus) the modal unlock window over the main wallet window. */
export function showUnlockWindow(deps: UnlockDeps): void {
  if (unlockWin && !unlockWin.isDestroyed()) {
    unlockWin.focus();
    return;
  }
  const parent = deps.getMainWindow() ?? undefined;
  const preload = path.join(__dirname, '../preload/unlock.js');
  unlocked = false;
  // Cover the main window so the lock reads as the app's locked STATE (a
  // full-bleed lock screen), not a small floating dialog. Match the parent's
  // bounds when there is one; otherwise fall back to the default window size.
  const cover = parent && !parent.isDestroyed() ? parent.getBounds() : null;
  unlockWin = new BrowserWindow({
    width: cover?.width ?? 1100,
    height: cover?.height ?? 800,
    ...(cover ? { x: cover.x, y: cover.y } : {}),
    parent,
    modal: Boolean(parent),
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

  unlockWin.once('ready-to-show', () => {
    // Single-window lock screen: hide the main wallet window while locked so the
    // unlock window is the ONLY thing on screen (it reads as the app's locked
    // state, not a second window beside the app). finishUnlock reveals main on
    // success; createWindow's ready-to-show skips the initial show when locked.
    if (parent && !parent.isDestroyed()) parent.hide();
    unlockWin?.show();
  });

  // The lock cannot be bypassed: dismissing the unlock window (its close button)
  // while still locked quits the app rather than revealing the wallet.
  unlockWin.on('close', () => {
    if (!unlocked) app.quit();
  });
  unlockWin.on('closed', () => {
    unlockWin = null;
  });

  void unlockWin.loadFile(path.join(__dirname, '../unlock/index.html'));
}
