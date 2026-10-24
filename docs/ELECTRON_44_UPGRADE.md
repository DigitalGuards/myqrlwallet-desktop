# Electron 44 upgrade review

This historical review covers Desktop 1.4.1 and Electron 44.7.0. Desktop 1.4.4
uses Electron 44.9.3, Chromium 152.0.7977.167 and Node 24.22.0; see
[SECURITY.md](../SECURITY.md) for the current runtime baseline and limits.

The desktop runtime moves from Electron 42.11.12 to 44.7.0, declared as
`^44.7.0` and pinned by `package-lock.json`. Electron 44 bundles Chromium 152
and Node 24.18.1. The development floor remains Node 22.13.0 with
`@types/node: ^22.0.0`; electron-vite 5 and electron-builder 26 stay in place.

This review uses the supplied Electron breaking-change document and the release
notes for [43.0.0](https://github.com/electron/electron/releases/tag/v43.0.0),
[44.0.0](https://github.com/electron/electron/releases/tag/v44.0.0) and
[44.7.0](https://github.com/electron/electron/releases/tag/v44.7.0). Frontend
references below are relative to `myqrlwallet-frontend` revision
`1f179c2e16dda2a1ef22cbad160f3652856adb77`, archived from the local `origin/dev`
reference into the ignored `out/frontend-source` build directory.

Outcome meanings: **not applicable** means the changed API or configuration is
unused; **adapted** includes existing compatible controls retained after review.
There are no unresolved decisions for this upgrade. Native GUI behavior remains
outside this review's execution scope.

## Every listed breaking change

| Version | Change | Outcome and code evidence |
| --- | --- | --- |
| 43 | Linux frameless rounded corners | **Not applicable.** Both `BrowserWindow` constructors use the native frame (`src/main/index.ts:341`, `src/main/unlockWindow.ts:258`). Settings uses a `WebContentsView` (`src/main/settingsView.ts:375`). There is no `frame: false` or custom rounded-corner policy. |
| 43 | Linux Window Controls Overlay follows native button layout | **Not applicable.** No `titleBarOverlay`, hidden title bar, or CSS titlebar layout exists in the shell. Native frames own the controls. |
| 43 | `NativeImage.toBitmap` / `getBitmap` normalizes to sRGB | **Not applicable.** The shell supplies PNG window icons (`src/main/appIcon.ts`); it does not read or compare native bitmap pixels. |
| 43 | `chrome.scripting` CSS injection reaches fallback frames | **Not applicable.** No extensions are loaded and no Chrome scripting API is used. |
| 43 | Open/save dialogs default to Downloads, with home fallback | **Not applicable to an Electron dialog call site.** The shell has no `showOpenDialog`, `showSaveDialog`, sync equivalents, or `defaultPath` override. Wallet file import uses an HTML file input (`src/components/Core/Body/ImportAccount/ImportEncryptedWallet/ImportEncryptedWallet.tsx:282` in the frontend); its export helper uses a Blob download (`src/utils/crypto/walletEncryption.ts:489`). These keep Chromium's picker/download behavior. There is no app-owned last-directory guarantee to preserve. |
| 43 | Linux `showHiddenFiles` removed | **Not applicable.** No shell or frontend call sets this option. Visibility of hidden files remains a picker/user preference. |
| 44 | `select-client-certificate` also covers `net` and utility processes; `webContents` may be null and certificates may be selected automatically | **Not applicable to current requests.** There is no event listener to dereference `webContents`. The sole `net.fetch` call loads a contained local `file:` URL (`src/main/index.ts:314`). RPC uses Node's global `fetch` (`src/main/rpc.ts:47`), and the isolated signer does not request main-process authentication (`src/main/signerBridge.ts:109`). No new remote Chromium request gains certificate selection. |
| 44 | macOS 12 removed | **Adapted.** `mac.minimumSystemVersion` is `13.0.0` in `electron-builder.yml:56`; README prerequisites state macOS 13+. macOS packaging is configured but was not exercised on this Linux host. |
| 44 | ANGLE statically linked; separate EGL/GLES libraries removed | **Not applicable to app code.** No custom ANGLE binaries, graphics switches, or library replacement hooks exist. Packaging uses the stock Electron distribution. |
| 44 | Frame destinations in `net.request` require navigate mode | **Not applicable.** There is no `net.request` call and no `Sec-Fetch-Dest` / `Sec-Fetch-Mode` override. Local `net.fetch` creates its own request. |
| 44 | Unity support and `app.isUnityRunning` removed | **Not applicable.** No Unity checks, badges or progress bars are used. The 44.0 notes also restore badge/progress functionality through LauncherEntry D-Bus; that restoration is unused. |
| 44 | Windows ia32 and Linux armv7l removed | **Adapted by existing targets.** Windows and macOS explicitly select x64/arm64 (`electron-builder.yml:58`, `:90`); `dist:linux` selects x64 (`package.json:30`). The Linux directory smoke uses the host's x64 architecture. No release script requests ia32 or armv7l. |
| 44 | Renderer Electron `clipboard` module removed | **Adapted by existing browser APIs.** All three preloads expose named wallet/unlock/settings wrappers (`src/preload/index.ts:59`, `src/unlock/preload.ts:27`, `src/settings/preload.ts:61`). None imports or exposes Electron clipboard. Renderer text/PNG copies use `navigator.clipboard`; see the complete inventory below. |
| 44 | Main Electron clipboard becomes asynchronous, changes item/MIME shape, removes narrow helpers and selection arguments | **Not applicable.** Main, signer and preloads have no Electron clipboard import or method call. No synchronous result assumptions, removed helpers or selection-clipboard accesses need migration. |
| 44 | Pre-macOS 13 login-item fields removed | **Not applicable.** No `getLoginItemSettings` / `setLoginItemSettings`, `openAsHidden`, `wasOpenedAsHidden` or login `restoreState` accesses exist. |

## Clipboard inventory

The shell's only clipboard policy is `src/main/permissions.ts:23`: both the
request and check handlers grant `clipboard-sanitized-write`, and all other
permissions are denied. `clipboard-read` remains denied. The policy applies to
the default session before window creation (`src/main/index.ts:426`). The
wallet, unlock and settings preloads and `src/shared/bridge.ts` expose no
clipboard endpoint.

All frontend text-copy paths converge on the awaited
`navigator.clipboard.writeText` in `src/utils/nativeApp.ts:263`, directly or
through `src/hooks/useCopyToClipboard.ts`. Its callers are `QrlAddress`,
`AddressDisclosure`, `AddressBook`, `AccountImportSuccess`, `TokenStatus`, token
table columns, `MnemonicDisplay`, `SendStatus`, `MobilePairingDialog`,
`ActiveAccountDisplay`, `Transfer`, `CopyAddressButton` and
`TransactionSuccessful`. Their associated clipboard tests also use this helper.

The additional browser write is `CopyAddressButton.tsx:87`: an awaited
`navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])` for a QR
image, with a download fallback. This is the browser's `ClipboardItem`.
`src/components/UI/PinInput/PinInput.tsx:113` reads the user-initiated paste
event's `clipboardData`. There is no programmatic clipboard read.

The `COPY_TO_CLIPBOARD` / `CLIPBOARD_SUCCESS` message types and
`copyToClipboardNative` helper belong to the mobile bridge. Desktop selects the
browser branch: it strips the mobile-identifying user-agent token
(`src/main/index.ts:395`) and exposes `window.qrlWallet`. No IPC surface or
permission expansion is needed for Electron 44.

## Release-note behavior and boundary checks

The following groups cover the behavior changes, fixes and optional additions
in both major-version release notes, including entries already backported to
42. API families that the wallet does not use are grouped together.

| Area | Outcome and evidence |
| --- | --- |
| Chromium / Node / V8 stack | **Adapted.** `electron.vite.config.ts:66` targets `chrome152` for unlock/settings. Node 22 development types remain pinned; Electron's own transitive Node types are independent. The external frontend retains its own build target. NAPI Argon2 and pure-JS signing dependencies retain their existing loading paths. |
| Main snapshots, custom browser snapshot correction, ThinLTO/PGO, Linux toolkit/FontConfig startup, timers and IPC performance | **Adapted through the runtime upgrade.** No custom snapshot or Electron build is used. `LoadBrowserProcessSpecificV8Snapshot` is explicitly false. No app logic depends on startup timing or process titles. |
| Sandboxed preload prefetch, bytecode caching, corrected stack traces and stale-cache fix | **Adapted by existing controls.** All preloads remain CJS (`electron.vite.config.ts:45`) and use `contextBridge.exposeInMainWorld`. Every app surface uses `hardenedWebPreferences` (`src/main/security.ts:15`): sandbox/context isolation enabled, Node in renderer/workers/subframes disabled. Compiled bundles and package contents are checked locally. |
| Spare sandboxed renderer and preload/IPC converter optimizations | **Adapted by existing ordering.** CSP, permission handlers and navigation hooks are installed before creating the wallet/unlock/settings contents (`src/main/index.ts:420`). No spare-renderer flag is set. |
| `window.open` / iframe sandbox inheritance and inherited `nodeIntegrationInWorker` for child windows/webviews | **Adapted by existing controls.** `setWindowOpenHandler` returns deny; `will-attach-webview` prevents attachment; worker/subframe Node integration is false (`src/main/security.ts:15`, `:153`, `:163`). `will-navigate` and `will-redirect` remain blocked. |
| Custom-protocol CORS/no-cors corrections, `ProtocolResponse.url` session fix, stream-protocol error handling, new extension privilege | **Not applicable to the changed APIs.** The app registers only `protocol.handle('file')` (`src/main/index.ts:274`) on the default session, serves contained paths with `bypassCustomProtocolHandlers`, and adds CSP/nosniff to the response. There are no privileged custom schemes, legacy protocol registrations or extensions. |
| Utility-process networking/session support and auth routing | **Not applicable.** The signer uses `process.parentPort` and a minimal environment; it has no network calls or session/auth options (`src/main/signerBridge.ts:109`, `src/signer/index.ts`). |
| Optional `net.WebSocket`, `WebContents.clone`, global-shortcut suspension, view blur, Linux memory availability, native-theme differentiation and SF Symbols | **Not applicable.** No call site uses these newly added APIs. The new Node inspector-network flag also remains outside the packaged app's disabled Node-options/inspector fuse policy. |
| Utility-process startup and Windows exit fixes | **Adapted through the runtime upgrade.** The ready handshake, bounded restart policy and pending-request rejection remain in `src/main/signerBridge.ts`. Every signer exit drops the session and aborts confirmations, independently of exit-code value. |
| Native `dialog.showMessageBox` cancellation and Linux message-box implementation crash fix | **Adapted by existing controls.** `src/main/confirmationGate.ts:77` always supplies a parent and AbortSignal; it rechecks the signal after resolution, rejecting even a racing approval. Electron 44's declaration still documents cancellation semantics and the macOS parentless limitation. Existing tests cover lock/autolock/signer exit, renderer navigation/crash, arming delays and late approval. Native display and OS cancellation were not exercised. |
| Bare-filename `defaultPath` correction and downloaded ASAR files | **Not applicable to app-owned dialog options.** No native open/save options, PDF viewer integration or `will-download` handler exists. Browser file selection and downloads remain browser-owned. |
| ASAR fs copy/stat/Dirent fixes, cyclic-link rejection, integrity/preload behavior when app.asar is replaced, clearer integrity errors | **Adapted through the runtime upgrade.** `asar` stays enabled; native `.node` files stay unpacked, and the integrity/ASAR-only fuses stay on. No updater replaces the archive at runtime. Fuse readback verifies configuration; it does not exercise platform integrity enforcement. |
| File installation and extraction changes, removed `ELECTRON_SKIP_BINARY_DOWNLOAD`, target-platform path correction, native-extractor fallback | **Adapted in validation.** `npm ci` is followed by an explicit `node node_modules/electron/install.js` when dist is absent. The installed version file and executable are checked before packaging. No skip-download variable is required. |
| `safeStorage.isAsyncEncryptionAvailable` Promise correction and ESM keychain access fix | **Not applicable to the changed method.** `src/keyvault/safeStorageVault.ts` uses `isEncryptionAvailable`, `encryptString` and `decryptString`. This optional vault retains its existing behavior. Touch ID uses the signed helper, without WebAuthn APIs. |
| Window min/max creation constraints, DPI/position/centering, focus/visibility, maximize/restore/fullscreen, Wayland/GNOME rendering | **Adapted by existing window configuration.** The wallet starts at 1100x800 with a 720x560 minimum; unlock copies the current bounds. Native frames handle decorations. Settings retains its separate `WebContentsView`, sender gate and presentation watchdog. There are no custom constraints, WCO, opacity, transparency, click-through or shadow controls to migrate. Cosmetic results need native-platform observation. |
| Hidden `WebContentsView` drag regions and background throttling | **Not applicable to the changed options.** The app defines no drag region or `setBackgroundThrottling(false)`. Settings still loads before attachment and is destroyed on close/lock (`src/main/settingsView.ts`). |
| `render-process-gone` teardown ordering and cross-origin frame-detail crashes | **Adapted by existing failure handling.** The confirmation gate aborts on renderer loss; it does not synchronously reload or navigate from that event. The IPC sender gate handles a null frame (`src/main/security.ts:105`). |
| Menus, accessibility events, application/protocol names, XDG App ID/WM_CLASS, external-link shutdown and single-instance argument fixes | **Adapted through the runtime upgrade.** The shell supplies its own menu, icon, app ID and bounded protocol ingress. These fixes preserve that design. Optional menu badges/accessibility labels and window-state/zoom/caret APIs are unused. |
| Main `process.exit` semantics, TLS shutdown, session-at-quit and native platform shutdown fixes | **Adapted through the runtime upgrade.** Main uses `app.quit`/`app.exit`; no string `process.exit` argument or shutdown-created session exists. Signer cleanup and explicit exit behavior are retained. |
| WebAssembly streaming with Node-enabled renderers and Apple Silicon Buffer/TextEncoder corrections | **Adapted through the runtime upgrade.** Renderer Node integration remains false. CSP still allows WebAssembly via `wasm-unsafe-eval`; the Wasm trap fuse stays enabled. Crypto tests exercise binary serialization on the development host. |
| DevTools, remote debugging, tracing/profiling, OOM/crash reporting and source-build/tooling fixes | **Not applicable to app-specific code.** Packaged DevTools and Node inspector fuses stay off; no debugger/tracing/crashReporter hooks or custom Electron build exist. The existing tsx test runner runs on development Node. |
| Desktop capture, audio/media capture, WebHID selection, geolocation, local speech recognition, WebAuthn, notifications, shared textures, OSR and print/PDF fixes/additions | **Not applicable.** None of these Electron APIs is used. Permissions and device selection remain denied. No new API is exposed through a preload. |
| Spellcheck, datalist/autofill, text replacement, document titles and general Chromium rendering fixes | **Adapted through the runtime upgrade.** The bundled React renderers use normal Chromium behavior and have no matching Electron overrides. Native visual behavior was not tested. |
| Squirrel.Mac updates, Windows shortcut updates and 44.7.0 resumable/delta downloads | **Not applicable.** The app has no autoUpdater/electron-updater integration and `publish` is null. |
| 44.7.0 `net.fetch` non-ASCII response headers and multiple Set-Cookie fix | **Not applicable to remote networking.** The sole Electron fetch serves local files; Node fetch handles RPC. The runtime includes the fix. |
| Chromium, V8, ANGLE, Dawn, Skia, fontconfig and WebRTC backports; smaller Linux locales/distribution | **Adapted through the runtime upgrade.** Stock Electron assets are packaged. No removed EGL/GLES libraries or fixed locale-size assumptions are referenced. |

## Packaging and fuse policy

`@electron/fuses` remains at 2.1.3, also the npm registry's current version at
review time. Its V1 enum recognizes all nine fuses read from the Electron 44.7.0
Linux binary. `scripts/afterPack.cjs` now requires complete configuration and
explicitly preserves the previously inherited snapshot, file-protocol and
WebAssembly settings. The hook still runs before signing and resets the macOS
ad-hoc signature when applicable.

| Fuse | Observed Linux packaged state |
| --- | --- |
| RunAsNode | Disabled |
| EnableCookieEncryption | Enabled |
| EnableNodeOptionsEnvironmentVariable | Disabled |
| EnableNodeCliInspectArguments | Disabled |
| EnableEmbeddedAsarIntegrityValidation | Enabled |
| OnlyLoadAppFromAsar | Enabled |
| LoadBrowserProcessSpecificV8Snapshot | Disabled |
| GrantFileProtocolExtraPrivileges | Enabled |
| WasmTrapHandlers | Enabled |

The existing `file://` privilege tradeoff remains documented in
`THREAT_MODEL.md`. A custom-scheme migration and disabling its privilege fuse
are a separate architectural change. Unit tests exercise the actual hook and
fuse library on synthetic wires, including rejection of an unknown tenth fuse
before any bytes change. The packaging smoke checks the real Linux binary.

The enabled integrity fuse in this historical readback is a configuration
result. Electron enforces embedded ASAR integrity on macOS and Windows. A later
synthetic probe on Linux with Electron 44.9.3 and the release fuse hook executed
modified JavaScript inside the ASAR without updating its hashes; see
[the platform limits](../SECURITY.md#7-asar-integrity).

`electron-builder.yml` excludes `out/frontend-source/**` so the source archive
and its build dependencies stay outside the application ASAR. Only the staged
renderer output belongs in that package.

## Validation scope

Required local gates are dependency installation, binary installation when
needed, formatting, lint, TypeScript, the Node test suite, the full shell and
archived-frontend build, Linux directory packaging, and real packaged fuse
readback. The results below were observed on development Node 22.22.3 with
npm 10.9.8, electron-vite 5.0.0 and electron-builder 26.15.3. No GUI was launched;
OS dialog appearance, native clipboard behavior, macOS/Windows packaging and
end-to-end signer operation under the Electron runtime remain untested here.

| Gate | Exit code | Result |
| --- | --- | --- |
| `npm ci` | 0 | Locked shell dependencies installed. |
| `node node_modules/electron/install.js` | 0 | Explicit install was needed; dist and its executable exist, and dist/version is 44.7.0. |
| `npm run format:check` | 0 | Configured source and hook formatting passes. |
| `npm run lint` | 0 | No lint warnings or errors. |
| `npm run typecheck` | 0 | Passes with direct `@types/node` 22.20.0. |
| `npm test` | 0 | 464 passed, zero failed or skipped; includes the two added fuse tests. |
| Local frontend `origin/dev` archive extraction | 0 | Source revision recorded above; original checkout remains untouched. |
| `QRL_FRONTEND_DIR=$PWD/out/frontend-source npm run build` | 0 | Shell, preloads, native pages and real frontend built; desktop CSP staged. |
| `npx electron-builder --linux dir -c.extraMetadata.homepage=https://github.com/DigitalGuards/myqrlwallet-desktop` | 0 | Unsigned Linux x64 directory package produced; afterPack completed. |
| `npx @electron/fuses read --app release/linux-unpacked/myqrlwallet-desktop` | 0 | All nine states match the table above. |
| ASAR content inspection | 0 | Source archive excluded; all eight entrypoints present, three CJS preloads intact, renderer CSP present and both packaged Argon2 native modules unpacked. |

The frontend install reported 34 dependency advisories (5 moderate, 29 high).
Its build also reported chunk-size and mixed static/dynamic-import warnings.
These come from the archived frontend dependency/build configuration and were
not remediated in this desktop runtime upgrade. Packaging reported duplicate
dependency references and skipped signing with the available environment.
