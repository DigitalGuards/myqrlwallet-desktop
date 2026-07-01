# Security

This document describes the renderer-hardening controls as IMPLEMENTED in this
repository, where each lives in code, the signer-isolation invariant, and how to
report a vulnerability. The design rationale is in
[`docs/ARCHITECTURE_RESEARCH.md`](docs/ARCHITECTURE_RESEARCH.md); the honest
limits of each control are in [`THREAT_MODEL.md`](THREAT_MODEL.md).

## Renderer-hardening checklist (as built)

The cardinal property is that even a fully compromised renderer yields NO key
material, because keys never live there. The controls below keep the renderer
from escalating beyond its sandbox.

### 1. `webPreferences`

Set explicitly in `hardenedWebPreferences()`, even where they are already the
Electron default, so a future Electron upgrade or a stray edit cannot silently
weaken containment.

`src/main/security.ts`:

```ts
{
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  devTools: !isPackaged(),   // DevTools never in a packaged build
}
```

Applied at window creation in `src/main/index.ts` (`createWindow`).

### 2. Strict Content-Security-Policy

Delivered as a real response header on every `file://` response by the
file-protocol handler in `src/main/index.ts` (`protocol.handle('file')`).
`webRequest.onHeadersReceived` does not reliably fire for `file://` document
loads, so the same policy is additionally installed there
(`installContentSecurityPolicy()`) only to cover http(s) responses (the dev
server), and `scripts/build-renderer.sh` rewrites the built renderer's meta CSP
to the same policy as defense-in-depth.

`src/main/security.ts`:

```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
connect-src 'self' <configured RPC/backend origins>;
img-src 'self' data: https:;
media-src 'self' blob:;
font-src 'self' data:;
object-src 'none';
frame-ancestors 'none';
base-uri 'self';
form-action 'self';
worker-src 'self' blob:
```

The load-bearing control is `script-src 'self'`: no `unsafe-inline` and no
`unsafe-eval` for SCRIPT, so a renderer compromise can neither inject nor `eval`
executable code. `style-src` allows `'unsafe-inline'` because the reused frontend
(Radix UI) sets inline STYLE attributes at runtime; inline style cannot execute
code, so this is a much-lower-risk relaxation than inline script would be.
`base-uri`/`form-action` are `'self'`, which resolves to `file://` for the
packaged renderer and is therefore effectively as tight as `'none'`. The
`connect-src` origins are derived from the configured RPC/backend endpoints in
`src/main/config.ts` (`connectSrcOrigins()`); the renderer can reach those and
nothing else. In `npm run dev` the Vite dev-server origin and its HMR websocket
are appended to `connect-src` only (see `src/main/index.ts`); production is never
widened.

`X-Content-Type-Options: nosniff` is set on the same response.

### 3. IPC sender + schema validation

Every `ipcMain.handle` enforces, in order: (1) sender validation, (2) zod parse,
(3) the action. The signer re-validates the subset it receives.

- Sender validation: `isTrustedSender()` in `src/main/security.ts`. Requires the
  event to come from the top frame (`webContents.mainFrame`) of the wallet
  window, loaded from a `file:` origin. Sub-frames / iframes and any non-`file:`
  origin are rejected, so a malicious embedded frame cannot invoke signing
  channels.
- Schema parse: the `handle()` wrapper in `src/main/ipc.ts` `safeParse`s each
  argument against the zod schemas in `src/shared/schemas.ts`. Parsing (not
  type-asserting) rejects malformed, oversized, or extra-keyed inputs at the
  boundary, before reaching crypto code. All request schemas are `.strict()`.
- Spend path: `wallet:requestSignature` additionally routes through the trusted
  main-drawn confirmation modal (`confirmSignature()` in `src/main/confirm.ts`)
  before any signing occurs. The renderer cannot spoof what is being signed.

The preload (`src/preload/index.ts`) exposes only the named functions of
`QrlWalletApi` (`src/shared/bridge.ts`) over `contextBridge`. There is no raw
`ipcRenderer` pass-through, no `require`, no `fs`/`child_process`/`eval`. A
compromised renderer cannot address an arbitrary IPC channel.

### 4. Navigation lockdown

`lockDownNavigation()` in `src/main/security.ts`, attached to every
`web-contents-created`:

- `will-navigate`: `preventDefault` always (a `file://` SPA never legitimately
  navigates the top document away); an allowlisted external link is handed to the
  OS browser instead of dead-ending.
- `setWindowOpenHandler`: deny the Electron window unconditionally; an allowlisted
  external link is opened in the user's REAL browser via `shell.openExternal`. The
  allowlist (`EXTERNAL_ALLOWLIST` in `src/main/externalLinks.ts`; https-only,
  exact host or subdomain on a dot boundary) is: qrlwallet.com, zondscan.com,
  theqrl.org, github.com, t.me. Arbitrary token / NFT / dApp-supplied URLs are NOT
  allowlisted and are intentionally dropped (a no-op) rather than launched. Unit
  tested in `test/externalLinks.test.ts`.
- `will-attach-webview`: deny outright, and strip `preload` / force
  `nodeIntegration: false` + `contextIsolation: true` defensively. There is no
  legitimate `<webview>` in this app.

A single-instance lock (`app.requestSingleInstanceLock()` in
`src/main/index.ts`) prevents a second process from racing the seed file.

### 5. Renderer permissions (deny-by-default)

`installPermissionHandlers()` in `src/main/permissions.ts`, installed on the
default session in `src/main/index.ts` before any window opens (so it covers both
the wallet window and the modal unlock window, which share the session). Electron
auto-grants permissions when no handler is set, and Chromium keeps widening the
device/media surface reachable by default, so the wallet refuses everything:

- `setPermissionRequestHandler` / `setPermissionCheckHandler`: grant ONLY
  `clipboard-sanitized-write` (used by "copy address"); deny camera, microphone,
  geolocation, notifications, `clipboard-read`, `fileSystem`, MIDI, and the rest.
- `setDevicePermissionHandler`: deny every WebUSB / HID / Serial / Bluetooth
  device-selection prompt. The wallet talks to no such device.

Covered by `test/security.permissions.test.ts`.

### 6. `@electron/fuses`

Compile-time fuses are flipped on the packaged binary in the `afterPack` hook
(`scripts/afterPack.cjs`, declared in `electron-builder.yml`), before signing, so
they are covered by the code signature. Intended settings:

- `RunAsNode`: off (no `ELECTRON_RUN_AS_NODE` escape hatch).
- `EnableNodeOptionsEnvironmentVariable`: off.
- `EnableNodeCliInspectArguments`: off (no `--inspect` debugger attach).
- `EnableEmbeddedAsarIntegrityValidation`: on.
- `OnlyLoadAppFromAsar`: on.
- `EnableCookieEncryption`: on.

Verify on a built app with `npm run fuses:read`.

### 7. ASAR integrity

`asar: true` in `electron-builder.yml`, with `OnlyLoadAppFromAsar` and
`EnableEmbeddedAsarIntegrityValidation` fuses on, so the app only loads code from
the signed `app.asar` and the runtime validates its integrity. Native binaries
(`@node-rs/argon2`'s prebuilt `.node`) cannot run from inside the asar, so
`asarUnpack: ['**/*.node']` extracts them to `app.asar.unpacked`; everything else
stays in the integrity-checked archive.

### 8. Supply chain and distribution

- Lockfile-pinned dependencies; pure-NAPI/JS crypto deps (no native build step,
  no `electron-rebuild`).
- electron-builder 26.x packaging with Authenticode (Windows) + notarization
  (macOS) + PGP-detached `.asc` sidecars on every artifact. See the README
  "Packaging and signing" section for the required environment.
- Keep Electron/Chromium current to close the V8 patch gap: context isolation
  can be defeated by an unpatched V8 type-confusion bug, so update cadence is
  itself a security control.

## Signer isolation invariant

The signer `utilityProcess` (`src/signer/index.ts`) is the ONLY process in which
plaintext key material (mnemonic, hex seed, ML-DSA-87 secret key) is ever
materialised, and only transiently. The invariant, enforced in code:

- It is forked by main via `utilityProcess.fork` and speaks ONLY to main over
  `process.parentPort`. The renderer has no handle to it and cannot address it.
- It refuses to run outside a `utilityProcess` (it throws if `process.parentPort`
  is absent), so it cannot be coaxed into signing as a plain `node` script.
- It owns no disk I/O: main owns the encrypted seed file (`src/main/seedFile.ts`).
  The signer never reads or writes it.
- Secret buffers are wiped on every path. The KDF KEK and the plaintext blob are
  wiped in `finally` blocks (`src/signer/index.ts` `handleImport`), the
  ML-DSA-87 `Wallet` is `zeroize()`d after every derive/sign
  (`src/signer/signing.ts`), and `session.lock()` runs on `process.exit` and on
  autolock (`src/signer/session.ts`).
- It exposes a single narrow verb set: import / unlock / sign / lock / status /
  shutdown (`src/shared/constants.ts` `SIGNER_MSG`). It never logs secrets; error
  replies carry only a short message, never the password or any key bytes.

See [`THREAT_MODEL.md`](THREAT_MODEL.md) for the explicit limits of this
invariant (notably the un-zeroizable V8 string holding the hex seed during a
signature, and the KEK transiting main when provisioning the OS keychain).

## Reporting a vulnerability

Please report security issues privately. Do not open a public issue for an
unpatched vulnerability.

- Email: security@digitalguards.nl
- Include: affected version/commit, a description, reproduction steps, and
  impact. A proof-of-concept is appreciated but not required.
- We aim to acknowledge within 3 business days and to coordinate a fix and
  disclosure timeline with you. Please allow reasonable time to remediate before
  public disclosure.

The spend-authorization path runs exclusively on the Halborn-audited
`@theqrl/mldsa87`. Findings in the signer, the IPC/preload boundary, or the
seed-at-rest format are the highest priority.
