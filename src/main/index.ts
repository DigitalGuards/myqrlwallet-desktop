/**
 * Main process entry point.
 *
 * Trust gradient (lowest -> highest): renderer (sandboxed React) -> preload
 * (contextBridge) -> THIS main broker -> signer utilityProcess. Main holds no
 * plaintext key material; it brokers IPC, draws the trusted confirmation modal,
 * proxies RPC, and owns the encrypted seed file on disk.
 */
import path from 'node:path';
import { app, BrowserWindow, session } from 'electron';
import { APP_ID, connectSrcOrigins } from './config';
import { registerIpcHandlers } from './ipc';
import {
  hardenedWebPreferences,
  installContentSecurityPolicy,
  lockDownNavigation,
} from './security';
import { SignerBridge } from './signerBridge';
import { createKeyVault } from '../keyvault';
import { EVENTS } from '../shared/constants';

let mainWindow: BrowserWindow | null = null;
const signer = new SignerBridge(() => {
  // Autolock fired inside the signer: notify the renderer.
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(EVENTS.LOCK_STATE_CHANGED, true);
  }
});

app.setName('MyQRLWallet');
// Hardening: a single instance, and no remote-content surprises.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

function rendererDevUrl(): string | undefined {
  // electron-vite sets this only in `npm run dev`.
  return !app.isPackaged ? process.env['ELECTRON_RENDERER_URL'] : undefined;
}

function createWindow(): void {
  const preloadPath = path.join(__dirname, '../preload/index.js');
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 720,
    minHeight: 560,
    show: false,
    backgroundColor: '#0b0d12',
    title: 'MyQRLWallet',
    webPreferences: hardenedWebPreferences(preloadPath),
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  const devUrl = rendererDevUrl();
  if (devUrl) {
    // Development only. Production ALWAYS uses loadFile (the brief's mandate).
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(async () => {
  // chromium app user model id (Windows notifications / taskbar grouping).
  if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

  // Strict CSP on the default session. In dev, also permit the Vite dev server
  // origin + its HMR websocket so the renderer can load with HMR.
  const connect = connectSrcOrigins();
  const devUrl = rendererDevUrl();
  if (devUrl) {
    try {
      const u = new URL(devUrl);
      connect.push(u.origin, `ws://${u.host}`);
    } catch {
      /* ignore */
    }
  }
  installContentSecurityPolicy(session.defaultSession, connect);

  lockDownNavigation(app);

  // Fork the signer and resolve the keyvault before exposing IPC.
  await signer.start();
  const keyVault = await createKeyVault({
    // Off by default: the safeStorage convenience layer has no user-presence
    // gate and is same-user readable. Opt in per build if you want it on
    // Windows/Linux; macOS uses the Touch-ID vault regardless.
    allowSafeStorageFallback: process.env.QRL_ALLOW_SAFESTORAGE === '1',
  }).resolve();

  registerIpcHandlers({ getWindow: () => mainWindow, signer, keyVault });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

let quitting = false;
app.on('before-quit', (event) => {
  if (quitting) return;
  quitting = true;
  // Give the signer a brief chance to zeroize and exit cleanly, but never block
  // quit on it: the signer self-exits ~50ms after acking shutdown and also
  // zeroizes on its own 'exit', so cap the wait well under the request timeout.
  event.preventDefault();
  const deadline = new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 2500);
    if (typeof t.unref === 'function') t.unref();
  });
  void Promise.race([signer.shutdown().catch(() => undefined), deadline]).finally(() => {
    app.exit(0);
  });
});
