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
import { isAllowedExternalUrl } from './externalLinks';

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
 * Build the renderer Content-Security-Policy string. `connectSrc` lists the
 * origins the renderer may reach (self + RPC + the frontend's backend/relay/
 * explorer).
 *
 * The renderer is the real myqrlwallet-frontend, so the policy is tuned to what
 * that app needs while preserving the property that matters most:
 *   - script-src 'self': NO 'unsafe-inline', NO 'unsafe-eval'. A renderer RCE
 *     cannot inject or eval script. This is the load-bearing control.
 *   - style-src 'self' 'unsafe-inline': Radix UI sets inline style attributes
 *     at runtime; inline STYLE cannot execute code, so this is an accepted,
 *     much-lower-risk relaxation than inline script would be.
 *   - img/media/font widened for token art, QR, data: assets.
 *   - worker-src 'self' blob:: the frontend's MLDSA worker is a Vite worker.
 * Keys never live in the renderer regardless, so even a CSP slip cannot leak
 * key material (that invariant is enforced by the signer, not the CSP).
 *
 * DELIVERY (both paths are needed; see the file-protocol handler in
 * src/main/index.ts): webRequest.onHeadersReceived does NOT reliably fire for
 * file:// document loads, so for the packaged file:// renderer this policy is
 * attached as a real response header by the protocol.handle('file') handler.
 * The webRequest install below still covers http(s) responses (the dev-server
 * case) and is harmless where both apply (identical policies intersect to
 * themselves).
 */
export function buildContentSecurityPolicy(connectSrc: string[]): string {
  const connect = ["'self'", ...connectSrc].join(' ');
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `connect-src ${connect}`,
    "img-src 'self' data: https:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "worker-src 'self' blob:",
  ].join('; ');
}

/** Install the CSP as a response header on every webRequest-visible response. */
export function installContentSecurityPolicy(session: Session, connectSrc: string[]): void {
  const csp = buildContentSecurityPolicy(connectSrc);

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
    // So the renderer is never steered to new in-app content. But an external
    // link (the explorer, theqrl.org, a token's site) clicked as a plain
    // <a href> DOES fire will-navigate; rather than dead-ending it (the links
    // would appear broken), hand an allowlisted external link to the OS browser.
    contents.on('will-navigate', (event, url) => {
      event.preventDefault();
      if (isAllowedExternalUrl(url)) {
        setImmediate(() => void shell.openExternal(url));
      }
    });
    // Server/redirect-driven navigations are never legitimate here and must not
    // auto-launch the browser (a redirect chain could point anywhere): block.
    contents.on('will-redirect', (event) => event.preventDefault());

    contents.setWindowOpenHandler(({ url }) => {
      // target=_blank / window.open: open allowlisted external links (e.g.
      // zondscan) in the user's real browser, never in an Electron window. A
      // non-allowlisted URL is dropped (not opened): see externalLinks.ts.
      if (isAllowedExternalUrl(url)) {
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
