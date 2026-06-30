/**
 * Main process entry point.
 *
 * Trust gradient (lowest -> highest): renderer (sandboxed React) -> preload
 * (contextBridge) -> THIS main broker -> signer utilityProcess. Main holds no
 * plaintext key material; it brokers IPC, draws the trusted confirmation modal,
 * proxies RPC, and owns the encrypted seed file on disk.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, Menu, protocol, session } from 'electron';
import { APP_ID, connectSrcOrigins } from './config';
import { registerIpcHandlers } from './ipc';
import {
  hardenedWebPreferences,
  installContentSecurityPolicy,
  lockDownNavigation,
} from './security';
import { installPermissionHandlers } from './permissions';
import { SignerBridge } from './signerBridge';
import {
  registerUnlockIpc,
  showUnlockWindow,
  isUnlockActive,
  type UnlockDeps,
} from './unlockWindow';
import { hasSeed } from './seedFile';
import { createKeyVault, type KeyVault } from '../keyvault';
import { EVENTS } from '../shared/constants';

let mainWindow: BrowserWindow | null = null;
let keyVaultRef: KeyVault | null = null;
const signer = new SignerBridge(() => {
  // Autolock fired inside the signer (or the signer crashed): notify the
  // renderer AND surface the native unlock window so the session can be
  // reopened. keyVaultRef is set once the vault resolves at boot.
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(EVENTS.LOCK_STATE_CHANGED, true);
  }
  if (keyVaultRef) {
    showUnlockWindow({ getMainWindow: () => mainWindow, signer, keyVault: keyVaultRef });
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

const RENDERER_DIR = path.join(__dirname, '../renderer');

/**
 * The reused frontend references some assets by ROOT-absolute paths it authored
 * for web hosting (e.g. the logo `/icons/theqrlwallet/192.png`, `/tree.svg`).
 * Under loadFile (file://) those resolve to the filesystem root and 404. We
 * intercept the file scheme and, when a requested path does not exist on disk,
 * remap it under the renderer dir. A traversal guard keeps every served path
 * inside RENDERER_DIR. Existing paths (the relative ./assets bundle) pass
 * through untouched. No frontend change required.
 */
function installRendererAssetResolver(): void {
  protocol.interceptFileProtocol('file', (request, callback) => {
    let filePath: string;
    try {
      filePath = fileURLToPath(request.url);
    } catch {
      callback({ statusCode: 400 });
      return;
    }
    if (existsSync(filePath)) {
      callback({ path: filePath });
      return;
    }
    let urlPath = '/';
    try {
      // A root-absolute web path (e.g. /assets/x.js, /tree.svg) resolves under
      // the file: scheme to the drive/filesystem root. On Windows that yields a
      // pathname of /C:/assets/x.js, so we strip the leading slash(es) AND an
      // optional <drive>: prefix; on POSIX only the leading slash is present.
      // The path then remaps under RENDERER_DIR on every platform.
      urlPath = new URL(request.url).pathname.replace(/^\/+/, '').replace(/^[A-Za-z]:\//, '');
    } catch {
      /* keep default */
    }
    const candidate = path.normalize(path.join(RENDERER_DIR, urlPath));
    if (candidate.startsWith(RENDERER_DIR + path.sep) && existsSync(candidate)) {
      callback({ path: candidate });
      return;
    }
    callback({ path: filePath }); // let it 404 naturally
  });
}

function rendererDevUrl(): string | undefined {
  // The renderer is the real myqrlwallet-frontend (built into out/renderer by
  // scripts/build-renderer.sh). For live frontend HMR, point QRL_RENDERER_DEV_URL
  // at the frontend's Vite dev server (e.g. http://127.0.0.1:5173). Otherwise
  // production-style loadFile of the built bundle is used.
  return !app.isPackaged ? process.env['QRL_RENDERER_DEV_URL'] : undefined;
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
    autoHideMenuBar: true,
    webPreferences: hardenedWebPreferences(preloadPath),
  });

  mainWindow.once('ready-to-show', () => {
    // Stay hidden if the wallet is locked at startup: the unlock window is the
    // only thing shown until the user unlocks (single-window lock screen).
    if (!isUnlockActive()) mainWindow?.show();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  const devUrl = rendererDevUrl();
  if (devUrl) {
    // Development only. Production ALWAYS uses loadFile (the brief's mandate).
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(path.join(RENDERER_DIR, 'index.html'));
  }
}

app.whenReady().then(async () => {
  // chromium app user model id (Windows notifications / taskbar grouping).
  if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

  // The reused frontend treats a userAgent containing "MyQRLWallet" as the
  // MOBILE native-app host (it then shows the camera QR scanner, biometric
  // bridge, etc. via isInNativeApp()). Electron's default UA appends the app
  // name + version, which would falsely trip that mobile path. Strip the app
  // (and Electron) token so the frontend runs as the desktop/web build, not the
  // mobile webview. Desktop-specific behavior comes from window.qrlWallet.
  app.userAgentFallback = app.userAgentFallback
    .replace(/\s*MyQRLWallet\/[^\s]+/g, '')
    .replace(/\s*Electron\/[^\s]+/g, '');

  // Remap the frontend's root-absolute asset paths (logo, /tree.svg) under file://.
  installRendererAssetResolver();

  // Drop the default Electron menu (File/Edit/View/Window/Help): a wallet has no
  // use for it. On macOS keep a minimal app + edit + window menu so the standard
  // shortcuts (Cmd+Q, copy/paste, close) still work; elsewhere remove it entirely.
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]),
    );
  } else {
    Menu.setApplicationMenu(null);
  }

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

  // Deny-by-default for every web permission (camera, mic, geolocation,
  // notifications, WebUSB/HID/Serial/Bluetooth, fileSystem); only clipboard
  // write is allowed. Covers the main window and the modal unlock window, which
  // share the default session.
  installPermissionHandlers(session.defaultSession);

  lockDownNavigation(app);

  // Fork the signer and resolve the keyvault before exposing IPC.
  await signer.start();
  const keyVault = await createKeyVault({
    // Off by default: the safeStorage convenience layer has no user-presence
    // gate and is same-user readable. Opt in per build if you want it on
    // Windows/Linux; macOS uses the Touch-ID vault regardless.
    allowSafeStorageFallback: process.env.QRL_ALLOW_SAFESTORAGE === '1',
  }).resolve();
  keyVaultRef = keyVault;

  const unlockDeps: UnlockDeps = { getMainWindow: () => mainWindow, signer, keyVault };
  registerUnlockIpc(unlockDeps);
  registerIpcHandlers({
    getWindow: () => mainWindow,
    signer,
    keyVault,
    showUnlock: () => showUnlockWindow(unlockDeps),
  });

  createWindow();

  // If a wallet already exists, the freshly-forked signer is locked: gate the
  // app behind the native unlock window before the wallet can be touched.
  if (await hasSeed()) showUnlockWindow(unlockDeps);

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
