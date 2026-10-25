/**
 * Centralised renderer-hardening controls. Every value here is set explicitly
 * even where it is already the Electron default, so a future Electron upgrade
 * or a stray edit cannot silently weaken the wallet's containment.
 *
 * Source of truth: ARCHITECTURE_RESEARCH.md "Renderer hardening checklist" and
 * the Electron security tutorial. Setup and import expose recovery material
 * to the renderer. These controls restrict its privileges and outbound paths.
 */
import { app, type BrowserWindow, type Session, shell, type WebPreferences } from 'electron';
import { isAllowedExternalUrl } from './externalLinks';
import { rendererServerOrigin } from './config';
import { APP_URLS, isAppDocument } from '../shared/appUrls';

// Replaced by electron-vite using the renderer's build-time backend setting.
// The fallback supports source-level tests and development tooling.
declare const __QRL_RENDERER_SERVER_ORIGIN__: string;
const SERVER_ORIGIN =
  typeof __QRL_RENDERER_SERVER_ORIGIN__ === 'string'
    ? __QRL_RENDERER_SERVER_ORIGIN__
    : rendererServerOrigin();

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
 * The renderer is the real myqrlwallet-frontend, with these resource needs:
 *   - script-src 'self' 'wasm-unsafe-eval': document inline JavaScript and JS
 *     eval are blocked. 'wasm-unsafe-eval' permits WebAssembly compilation
 *     ONLY (not JS eval); the frontend's hash-wasm argon2id needs it to import
 *     extension keystore backups at full speed (the pure-JS fallback works
 *     without it but takes ~20s per attempt at production KDF params). The
 *     wasm bytes come from the same bundled same-origin scripts script-src
 *     already trusts, so this does not widen where code can come FROM.
 *   - style-src 'self' 'unsafe-inline': Radix UI sets inline style attributes
 *     at runtime; inline STYLE cannot execute code, so this is an accepted,
 *     much-lower-risk relaxation than inline script would be.
 *   - img-src allows local assets, data images and the configured backend,
 *     including its IPFS proxy. Other artwork uses the frontend's placeholder.
 *   - worker-src 'self': the desktop crypto worker is a bundled Vite file.
 *     The mobile embedded build's inline worker is a separate build target.
 * Allowed servers and external links remain possible outbound channels.
 *
 * DELIVERY: the app protocol attaches this policy to every response, including
 * workers and errors. webRequest covers HTTP(S) development-server responses.
 * The bundled renderer also carries the matching meta policy.
 */
export function buildContentSecurityPolicy(connectSrc: string[]): string {
  const connect = ["'self'", ...connectSrc].join(' ');
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    `connect-src ${connect}`,
    `img-src 'self' data: ${SERVER_ORIGIN}`,
    "media-src 'self' blob:",
    "font-src 'self' data:",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "worker-src 'self'",
  ].join('; ');
}

/** Cover development HTTP(S); app responses already have authoritative headers. */
export function installContentSecurityPolicy(session: Session, connectSrc: string[]): void {
  const csp = buildContentSecurityPolicy(connectSrc);

  session.webRequest.onHeadersReceived(
    { urls: ['http://*/*', 'https://*/*'] },
    (details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [csp],
          'X-Content-Type-Options': ['nosniff'],
          'X-DNS-Prefetch-Control': ['off'],
        },
      });
    },
  );
}

/**
 * Validate that an IPC event originated from the top frame of the wallet
 * window loaded from the local app bundle. Rejects sub-frames/iframes (so a
 * malicious embedded frame cannot invoke signing channels) and unexpected
 * documents. Returns a boolean so callers decide the error shape.
 */
export function isTrustedSender(
  event: { sender: Electron.WebContents; senderFrame: Electron.WebFrameMain | null },
  mainWindow: BrowserWindow | null,
): boolean {
  const frame = event.senderFrame;
  // Fail closed on a torn-down frame or a missing/destroyed window.
  if (!frame || !mainWindow || mainWindow.isDestroyed()) return false;
  if (event.sender !== mainWindow.webContents) return false;
  if (frame !== mainWindow.webContents.mainFrame) return false; // reject sub-frames
  let url: URL;
  try {
    url = new URL(frame.url);
  } catch {
    return false;
  }
  if (isAppDocument(frame.url, APP_URLS.wallet)) return true;
  // Development only: the Vite dev server renders over http, so accept its
  // EXACT origin. Packaged builds accept only the wallet entry point.
  const devUrl = !app.isPackaged ? process.env['QRL_RENDERER_DEV_URL'] : undefined;
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
    // The wallet uses HTTPS/WebSockets. Limit WebRTC's direct UDP path;
    // TCP and proxy-mediated WebRTC remain residual channels.
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    // The app SPA with hash routing never legitimately navigates the top
    // document: route changes are hash-only and do not fire will-navigate, and
    // the initial load goes through loadURL (also not will-navigate).
    // So the renderer is never steered to new in-app content. But an external
    // link (the explorer, theqrl.org, a token's site) clicked as a plain
    // <a href> DOES fire will-navigate; hand an allowlisted external link to
    // the OS browser.
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
