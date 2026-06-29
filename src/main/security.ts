/**
 * Centralised renderer-hardening controls. Every value here is set explicitly
 * even where it is already the Electron default, so a future Electron upgrade
 * or a stray edit cannot silently weaken the wallet's containment.
 *
 * Source of truth: ARCHITECTURE_RESEARCH.md "Renderer hardening checklist" and
 * the Electron security tutorial. The cardinal property is that even a fully
 * compromised renderer yields NO key material, because keys never live there;
 * these controls keep the renderer from escalating beyond its sandbox.
 */
import { app, type BrowserWindow, type Session, shell, type WebPreferences } from 'electron';

/** webPreferences for the single wallet window. */
export function hardenedWebPreferences(preloadPath: string): WebPreferences {
  return {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    // DevTools only in development; never in a packaged build.
    devTools: !app.isPackaged,
  };
}

/**
 * Install a strict Content-Security-Policy on every response in `session`.
 * Delivered as a response header (authoritative for file://, and the only form
 * in which `frame-ancestors` is honored). `connectSrc` lists the explicit RPC
 * origins the renderer may reach.
 *
 * `style-src 'self'` is intentionally strict and works for a Vite+React+Tailwind
 * build, which extracts one static hashed stylesheet (no runtime <style>
 * injection). `img-src 'self' data:` is required so QR codes / data-URI assets
 * render. No 'unsafe-inline' or 'unsafe-eval' anywhere.
 */
export function installContentSecurityPolicy(session: Session, connectSrc: string[]): void {
  const connect = ["'self'", ...connectSrc].join(' ');
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    `connect-src ${connect}`,
    "img-src 'self' data:",
    "font-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    // No blob: (a script-src 'self' bypass primitive). Bundle workers as
    // same-origin assets instead.
    "worker-src 'self'",
  ].join('; ');

  session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
        'X-Content-Type-Options': ['nosniff'],
      },
    });
  });
}

/**
 * Validate that an IPC event originated from the top frame of the wallet
 * window loaded from the local app bundle. Rejects sub-frames/iframes (so a
 * malicious embedded frame cannot invoke signing channels) and any non-file:
 * origin. Returns false (not throws) so callers decide the error shape.
 */
export function isTrustedSender(
  event: { senderFrame: Electron.WebFrameMain | null },
  mainWindow: BrowserWindow | null,
): boolean {
  const frame = event.senderFrame;
  // Fail closed on a torn-down frame or a missing/destroyed window.
  if (!frame || !mainWindow || mainWindow.isDestroyed()) return false;
  if (frame !== mainWindow.webContents.mainFrame) return false; // reject sub-frames
  let url: URL;
  try {
    url = new URL(frame.url);
  } catch {
    return false;
  }
  if (url.protocol === 'file:') return true;
  // Development only: the Vite dev server renders over http, so accept its
  // EXACT origin. Production is strictly file:-only.
  const devUrl = !app.isPackaged ? process.env['ELECTRON_RENDERER_URL'] : undefined;
  if (devUrl) {
    try {
      return url.origin === new URL(devUrl).origin;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Lock down navigation and window creation for ALL web contents: block any
 * navigation away from the app origin, deny `window.open`, route allowlisted
 * external links through the OS browser, and neuter any <webview>.
 */
export function lockDownNavigation(app: Electron.App): void {
  app.on('web-contents-created', (_e, contents) => {
    // A file:// SPA with hash routing never legitimately navigates the top
    // document: route changes are hash-only and do not fire will-navigate, and
    // the initial load goes through loadFile/loadURL (also not will-navigate).
    // So block every navigation AND every server/redirect-driven navigation;
    // the renderer cannot be steered to new content under any origin.
    contents.on('will-navigate', (event) => event.preventDefault());
    contents.on('will-redirect', (event) => event.preventDefault());

    contents.setWindowOpenHandler(({ url }) => {
      if (isAllowlistedExternal(url)) {
        // Open in the user's real browser, not an Electron window.
        setImmediate(() => void shell.openExternal(url));
      }
      return { action: 'deny' };
    });

    contents.on('will-attach-webview', (event, webPreferences, params) => {
      delete webPreferences.preload;
      webPreferences.nodeIntegration = false;
      webPreferences.contextIsolation = true;
      // No legitimate <webview> in this app: deny outright.
      event.preventDefault();
      void params;
    });
  });
}

const EXTERNAL_ALLOWLIST = [
  'https://qrlwallet.com/',
  'https://zondscan.com/',
  'https://www.theqrl.org/',
  'https://theqrl.org/',
];

function isAllowlistedExternal(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    return EXTERNAL_ALLOWLIST.some((prefix) => url.startsWith(prefix));
  } catch {
    return false;
  }
}
