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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { app, BrowserWindow, Menu, net, protocol, session } from 'electron';
import { APP_ID, connectSrcOrigins } from './config';
import { DappUriIngress, extractDappUriFromArgv } from './dappUri';
import { registerIpcHandlers } from './ipc';
import {
  buildContentSecurityPolicy,
  hardenedWebPreferences,
  installContentSecurityPolicy,
  lockDownNavigation,
} from './security';
import { installPermissionHandlers } from './permissions';
import { SignerBridge } from './signerBridge';
import {
  notifyUnlockedExternally,
  registerUnlockIpc,
  showUnlockWindow,
  type UnlockDeps,
} from './unlockWindow';
import { hasAnySeed, migrateLegacySeed } from './seedFile';
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

/**
 * dApp-connect URI ingress (OS qrlconnect:// protocol handler). Delivery
 * surfaces the window and forwards the shape-validated URI to the renderer,
 * whose consent modal gates any relay contact. Focusing here is correct: the
 * user just clicked a connect link intending to open the wallet.
 */
const dappIngress = new DappUriIngress({
  deliver: (uri) => {
    const win = mainWindow;
    if (!win || win.isDestroyed()) return false;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.webContents.send(EVENTS.DAPP_CONNECT_URI, uri);
    return true;
  },
});

app.setName('MyQRLWallet');
// Hardening: a single instance, and no remote-content surprises.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

// Register as the qrlconnect:// handler so dApp "open in desktop wallet"
// links reach us. Packaged builds register the bare exe; unpackaged dev runs
// must pin execPath + the app path or Windows would launch a bare electron.
if (process.defaultApp) {
  if (process.argv.length >= 2 && process.argv[1]) {
    app.setAsDefaultProtocolClient('qrlconnect', process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient('qrlconnect');
}

app.on('second-instance', (_event, argv) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
  // Windows/Linux: a protocol launch while we are running lands in the second
  // instance's argv. Only the first qrlconnect: argument is treated as data.
  const uri = extractDappUriFromArgv(argv);
  if (uri) dappIngress.offer(uri);
});

// macOS: protocol launches arrive via open-url (register before 'ready').
app.on('open-url', (event, url) => {
  event.preventDefault();
  dappIngress.offer(url);
});

const RENDERER_DIR = path.join(__dirname, '../renderer');

/**
 * The file-protocol handler does two jobs:
 *
 * 1. Asset remapping. The reused frontend references some assets by
 *    ROOT-absolute paths it authored for web hosting (e.g. the logo
 *    `/icons/theqrlwallet/192.png`, `/tree.svg`). Under loadFile (file://)
 *    those resolve to the filesystem root and 404, so when a requested path
 *    does not exist on disk we remap it under the renderer dir. A traversal
 *    guard keeps every remapped path inside RENDERER_DIR; existing paths (the
 *    relative ./assets bundle) pass through untouched.
 *
 * 2. CSP delivery. webRequest.onHeadersReceived does NOT reliably fire for
 *    file:// document loads (empirically: the frontend's meta CSP, not the
 *    header, was the effective policy; see scripts/build-renderer.sh), which
 *    silently dropped the strict header policy in the packaged app. Serving
 *    file: through protocol.handle lets us attach the CSP as a REAL response
 *    header, restoring `script-src 'self'` as the enforced, load-bearing
 *    control on every platform. The rewritten meta tag in the built renderer
 *    (build-renderer.sh) remains as defense-in-depth.
 */
function installFileProtocolHandler(): void {
  const csp = buildContentSecurityPolicy(connectSrcOrigins());

  protocol.handle('file', async (request) => {
    let filePath: string;
    try {
      filePath = fileURLToPath(request.url);
    } catch {
      return new Response('bad request', { status: 400 });
    }
    if (!existsSync(filePath)) {
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
        filePath = candidate;
      }
    }
    // Containment: this handler intercepts EVERY file:// request, so a
    // compromised renderer must not be able to read arbitrary host files (e.g.
    // /etc/passwd) by requesting them directly. Only files inside the app
    // bundle (the built renderer + the native unlock window, both under
    // app.getAppPath()) are ever served; anything else is a hard 403. The
    // remap branch above already constrains to RENDERER_DIR, which is inside
    // this root; this guard also covers the direct existsSync(filePath) case.
    const appRoot = path.normalize(app.getAppPath());
    const resolved = path.normalize(filePath);
    if (resolved !== appRoot && !resolved.startsWith(appRoot + path.sep)) {
      return new Response('forbidden', { status: 403 });
    }
    let served: Response;
    try {
      // bypassCustomProtocolHandlers avoids recursing into this handler; the
      // default loader supplies MIME detection and range/stream handling.
      served = await net.fetch(pathToFileURL(resolved).toString(), {
        bypassCustomProtocolHandlers: true,
      });
    } catch {
      return new Response('not found', { status: 404 });
    }
    const headers = new Headers(served.headers);
    headers.set('Content-Security-Policy', csp);
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(served.body, {
      status: served.status,
      statusText: served.statusText,
      headers,
    });
  });
}

function rendererDevUrl(): string | undefined {
  // The renderer is the real myqrlwallet-frontend (built into out/renderer by
  // scripts/build-renderer.sh). For live frontend HMR, point QRL_RENDERER_DEV_URL
  // at the frontend's Vite dev server (e.g. http://127.0.0.1:5173). Otherwise
  // production-style loadFile of the built bundle is used.
  return !app.isPackaged ? process.env['QRL_RENDERER_DEV_URL'] : undefined;
}

function createWindow(startLocked = false): void {
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
    // only thing shown until the user unlocks (single-window lock screen). This
    // is a deterministic flag resolved BEFORE the window was created, not a race
    // against showUnlockWindow assigning its window.
    if (!startLocked) mainWindow?.show();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    dappIngress.rendererGone();
  });

  // A cold-start protocol launch reaches us before the renderer exists; the
  // ingress buffers it and flushes here. Reloads re-fire both events, so the
  // buffer never delivers into a half-loaded document.
  mainWindow.webContents.on('did-start-loading', () => dappIngress.rendererGone());
  mainWindow.webContents.on('did-finish-load', () => dappIngress.rendererReady());

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

  // Serve file:// through protocol.handle: remaps the frontend's root-absolute
  // asset paths (logo, /tree.svg) AND attaches the strict CSP as a response
  // header (webRequest does not reliably cover file:// document loads).
  installFileProtocolHandler();

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

  // One-shot migration of the legacy single-wallet seed.json into the
  // per-address multi-wallet store, BEFORE anything reads the store.
  await migrateLegacySeed();

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
    notifyUnlocked: () => notifyUnlockedExternally(unlockDeps),
  });

  // Resolve the locked-at-startup decision BEFORE creating the window so its
  // ready-to-show is gated deterministically (no race against showUnlockWindow).
  const lockedAtStartup = await hasAnySeed();
  createWindow(lockedAtStartup);

  // Cold start via a protocol click (Windows/Linux): the URI is in OUR argv.
  // Buffered by the ingress until the renderer finishes loading.
  const coldStartUri = extractDappUriFromArgv(process.argv.slice(1));
  if (coldStartUri) dappIngress.offer(coldStartUri);

  // If a wallet already exists, the freshly-forked signer is locked: gate the
  // app behind the native unlock window before the wallet can be touched.
  if (lockedAtStartup) showUnlockWindow(unlockDeps);

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
