# MyQRLWallet Desktop

Post-quantum, self-custody QRL desktop wallet. An Electron shell built around a
hardened four-process architecture: a sandboxed renderer (the real
`myqrlwallet-frontend` React app, reused as-is), a broker main process, and an
isolated signer `utilityProcess` that is the sole holder of plaintext key
material. Even a fully compromised renderer yields no key material, because keys
never live there.

This implements the decision document in
[`docs/ARCHITECTURE_RESEARCH.md`](docs/ARCHITECTURE_RESEARCH.md). Read that first
for the "why"; this README is the "how to run/build" companion. The honest
security tradeoffs are in [`THREAT_MODEL.md`](THREAT_MODEL.md) and the
renderer-hardening checklist as-built is in [`SECURITY.md`](SECURITY.md).

## At a glance

- **Stack:** Electron 42 (latest stable; bundled Node 24 + Chromium 148) + electron-vite + electron-builder 26 (GA), TypeScript (strict). The renderer is the real `myqrlwallet-frontend` (React 19), built unchanged.
- **Renderer reuse:** the web wallet is the desktop UI, with no fork. It is built with `VITE_DESKTOP=1` and loaded over `file://`; the few desktop adaptations are runtime-gated and web-safe (see "Renderer reuse" below). A frontend update is just a rebuild.
- **Key isolation:** every key-touching operation (wallet generation, seed encrypt/decrypt, ML-DSA-87 signing) runs in the isolated signer. The renderer routes those through `window.qrlWallet`; its in-page seed/signing primitives are neutered (throw) under desktop, as defense-in-depth.
- **Post-quantum signing:** Halborn-audited `@theqrl/mldsa87` (ML-DSA-87 / FIPS 204, NIST Level 5), run ONLY inside the signer process.
- **Key at rest:** Argon2id (`@node-rs/argon2`) password-derived KEK + AES-256-GCM, with the macOS Keychain (Designated Requirement + Touch ID) as defense-in-depth. No PIN: the desktop unlock secret is a password.
- **Environment:** this is a STAGING build. The bundled renderer targets the dev environment (`dev.qrlwallet.com`), which CICD auto-deploys on every push to the frontend `dev` branch. Repoint with env vars (see "Renderer reuse").

## Download

Prebuilt installers are on the [Releases](https://github.com/DigitalGuards/myqrlwallet-desktop/releases/latest)
page: a Windows NSIS installer (`.exe`, x64), a universal Linux `AppImage`, and a
Debian/Ubuntu `.deb`. Each release lists SHA-256 checksums.

These binaries are currently **unsigned**: Windows SmartScreen warns on first
launch ("More info -> Run anyway"), and the Linux AppImage needs `chmod +x`
before running. Code-signing (Authenticode) and macOS notarization are a planned
follow-up; there is no macOS build yet. Builds are STAGING (they target
`dev.qrlwallet.com`); see "Pointing at an environment" to repoint.

To build the installers yourself, see "Packaging and signing" below.

## Prerequisites

- Node `>=22.13.0` for the dev toolchain. The repo pins `22` (current LTS) in
  `.nvmrc`; run `nvm use`. (The packaged app runs on Electron's own bundled Node,
  currently 24; this floor is only for building, testing, and packaging locally.)
- A sibling `../myqrlwallet-frontend` checkout. The renderer is built FROM that
  directory (never vendored into this repo), so the desktop and frontend repos
  sit side by side, both as submodules of the parent workspace. Initialise it
  with `git submodule update --init ../myqrlwallet-frontend` if absent.
- A C/C++ toolchain is NOT required: `@node-rs/argon2` and `@theqrl/*` are
  pure-NAPI / pure-JS. NAPI is ABI-stable across Node and Electron, so there is
  no `electron-rebuild` step.

## Quick start

```bash
nvm use                         # Node 22 LTS (.nvmrc)
npm install                     # legacy-peer-deps is preconfigured
npm run build:renderer:frontend # build the real frontend into out/renderer
npm run dev                     # launch the hardened shell against it
```

`npm run dev` builds main + preload in watch mode and launches Electron; it
loads the renderer from `out/renderer/index.html`. Build the renderer once first
(the command above) or the window is blank. For live frontend HMR, run the
frontend's own dev server and point the shell at it:

```bash
# in ../myqrlwallet-frontend:
VITE_DESKTOP=1 npm run dev      # e.g. http://localhost:5173
# in this repo:
QRL_RENDERER_DEV_URL=http://localhost:5173 npm run dev
```

Production ALWAYS uses `loadFile` over `file://`, never a remote URL; the dev
URL path is gated on `!app.isPackaged`.

## What works today

End-to-end, with every key-touching step performed in the signer:

- **Create a wallet:** the signer generates the seed, encrypts and persists it,
  and returns the recovery mnemonic ONCE for backup. The hex seed and secret key
  never leave the signer.
- **Import a wallet:** from a recovery mnemonic, a raw 51-byte hex extended seed,
  or an encrypted wallet file. The mnemonic and hex seed encode the same key, so
  the signer regenerates the canonical mnemonic and stores an identical envelope
  either way; the signer derives, encrypts, persists.
- **Multiple wallets:** any number of accounts on one device, each encrypted
  under its own password (one envelope per address at
  `userData/wallet/seeds/<address>.json`, plus an `active.json` pointer). Add,
  switch, and remove accounts individually. The signer holds at most one unlocked
  session at a time, so switching to another account requires unlocking it (the
  isolation tradeoff, see [`THREAT_MODEL.md`](THREAT_MODEL.md)). A legacy
  single-wallet `seed.json` migrates into this layout once at boot.
- **Unlock / lock:** a native, app-drawn unlock window (`src/unlock/`, not the
  web renderer) collects the password; it shows an account picker when more than
  one wallet exists. Password unlock (Argon2id KEK), macOS Touch-ID / keychain
  unlock, and a sliding auto-lock that zeroizes and notifies the renderer.
- **Remove a wallet:** deletes one account's encrypted seed and clears its
  keychain entry, ONLY after a trusted main-drawn confirmation that names the
  address; other accounts are untouched.
- **Balance + assembly:** balance reads and unsigned type-2 (EIP-1559)
  transaction assembly via the bundled RPC proxy.
- **Sign + broadcast:** native transfers, QRC20 token transfers, token creation,
  and NFT transfers, plus dApp-connect `qrl_sendTransaction` /
  `qrl_signTransaction` / `qrl_signMessage`. Each spend is gated by the trusted
  main-drawn confirmation modal and is byte-faithful to the web wallet, so
  signatures verify identically. Signing is fully offline, and the confirmed
  chain id is exactly the one signed.

Typed-data signing (`qrl_signTypedData`) is intentionally fast-failed until its
byte-exact hasher is ported (see
[`docs/FRONTEND_INTEGRATION.md`](docs/FRONTEND_INTEGRATION.md)); it never signs a
digest the dApp side could not reproduce.

## Architecture: four processes, one trust gradient

Trust runs lowest to highest. Key material never moves down the gradient.

| Process | Trust | Has Node? | Holds keys? | Responsibility |
|---|---|---|---|---|
| Renderer | Lowest (treated as fully untrusted) | No (`sandbox: true`, `nodeIntegration: false`) | No | The real `myqrlwallet-frontend` UI. Talks only through `window.qrlWallet`. A full renderer RCE yields no key material because none lives here; in-page seed/signing primitives throw under desktop. |
| Preload | Bridge | No (tiny allowlist) | No | Mounts the narrow `window.qrlWallet` API over `contextBridge`. No raw `ipcRenderer`, no `require`. |
| Main (broker) | Mid | Yes | No (plaintext) | Window lifecycle, IPC sender + schema validation, the trusted confirmation modal, the RPC proxy, and the encrypted seed file on disk. |
| Signer (`utilityProcess`) | Highest, most isolated | Yes | Yes, transiently | The ONLY place the mnemonic, hex seed, and ML-DSA-87 secret key are ever materialised. Wallet generation, Argon2id KDF, AES-256-GCM decrypt, sign, zeroize. Speaks only to main over `parentPort`; the renderer has no handle to it. |

The renderer can at most ask for a signature over a specific, user-confirmed
payload and get the result back. It cannot reach the signer, the disk, or the
network beyond the CSP `connect-src` allowlist.

### Data flow for a spend

1. Renderer calls `window.qrlWallet.requestSignature({ kind: 'transaction', tx })`.
2. Preload forwards it on the `wallet:requestSignature` IPC channel.
3. Main validates the sender (top frame, `file:` origin) and zod-parses the payload.
4. Main draws a trusted confirmation modal ("you are signing X to Y"). The renderer cannot spoof it.
5. On approval, main asks the signer to sign. The signer unwraps the seed, signs with `@theqrl/mldsa87`, zeroizes, and returns the raw signed tx.
6. Renderer broadcasts it via `window.qrlWallet.sendRawTransaction`.

## Renderer reuse: the web wallet IS the desktop UI

The renderer is not a fork or a port: it is the real `myqrlwallet-frontend`,
built by its own toolchain via `scripts/build-renderer.sh` into `out/renderer`
(run by `npm run build`). The frontend source is never copied into this repo, so
it cannot drift. Updating the desktop UI is just rebuilding the current frontend
checkout.

It needs only a handful of adaptations, all web-safe and runtime-gated by
`isDesktop = Boolean(window.qrlWallet)` so the web build is byte-identical:

- **Asset base** `VITE_DESKTOP=1` -> Vite `base: './'` for `file://`.
- **Routing** `createBrowserRouter` -> `createHashRouter`, switched at runtime
  when `window.qrlWallet` is present (no build flag, no HTML surgery).
- **Key ops** every seed/sign call site delegates to `window.qrlWallet` under
  desktop; the in-page crypto primitives throw if reached.
- **No PIN** the desktop unlock secret is a password; PIN UI is hidden under
  desktop and unlock prompts are replaced by the signer session.

Two main-process shims keep the unmodified web bundle working under `file://`:
a `protocol.handle('file')` handler (`installFileProtocolHandler`) remaps the
frontend's root-absolute asset paths (logo, `/tree.svg`), attaches the strict
CSP as a real response header (`webRequest` does not reliably fire for `file://`
document loads), and contains every served path to the app bundle so a
compromised renderer cannot read arbitrary host files; and
`app.userAgentFallback` strips the `MyQRLWallet` / `Electron` tokens so the
frontend runs as the desktop/web build, not its mobile webview.

### Pointing at an environment

This build is staging: it targets `dev.qrlwallet.com`. The frontend selects its
backend / RPC / explorer from `VITE_NODE_ENV` + `VITE_*_DEVELOPMENT` /
`_PRODUCTION` (frontend `src/config/networks.ts`). `build-renderer.sh` defaults
those to the dev environment; each is overridable from the environment, so a
prod build just exports `VITE_NODE_ENV=production` and the `*_PRODUCTION` vars
before building. The main-process CSP `connect-src` allowlist
(`src/main/config.ts` `frontendOrigins`) is kept in sync with those origins;
override it with `QRL_FRONTEND_ORIGINS` (space-separated) when repointing.

## Directory map

```
myqrlwallet-desktop/
  src/
    shared/        Cross-process pure data + types (no side effects):
                     constants.ts  IPC channels, EVENTS, BRIDGE_KEY, MLDSA87
                                    sizes, KDF_DEFAULTS, SCHEME tags, AEAD
                     schemas.ts    zod schemas + inferred request/result types
                     bridge.ts     QrlWalletApi + window.qrlWallet augmentation
                     protocol.ts   private main <-> signer message shapes
    preload/       contextBridge mount of window.qrlWallet (CJS, sandboxed)
    main/          Broker: index.ts (entry + file-protocol handler: CSP header,
                     asset remap, app-bundle containment + UA fix), ipc.ts
                     (handlers, incl. multi-wallet list/setActive/remove),
                     security.ts (CSP, sender validation, navigation lockdown),
                     permissions.ts (deny-by-default renderer permissions),
                     externalLinks.ts (trusted-host allowlist for openExternal),
                     config.ts (RPC + frontend origins, autolock), confirm.ts
                     (trusted modal), rpc.ts (proxy), seedFile.ts (multi-wallet
                     encrypted seeds at rest), unlockWindow.ts (native unlock
                     window + IPC), signerBridge.ts (fork + request/response)
    unlock/        Native, app-owned unlock window (its own small React renderer
                     + preload, built to out/unlock): index.html, main.tsx,
                     preload.ts, unlock.css
    signer/        Isolated highest-trust process: index.ts (entry, incl. the
                     create/import/unlock/sign/lock verbs), kdf.ts (Argon2id),
                     aead.ts (AES-256-GCM), signing.ts (ML-DSA-87 + web3 tx
                     signing + mnemonic generation), session.ts (in-memory
                     unlock + autolock), zeroize.ts (buffer wipe)
    keyvault/      OS app-binding (defense-in-depth): macKeychainVault.ts
                     (Touch ID, DR-bound), safeStorageVault.ts (DPAPI/libsecret,
                     no presence gate), nullVault.ts (password every unlock),
                     factory.ts (selects strongest available)
  native/macos-keychain/   Swift keychain helper source + build.sh
  resources/               Built helper lands here, copied into the .app bundle
  scripts/                 build-renderer.sh (builds the real frontend),
                             packaging hooks (afterPack/notarize/pgp-sign),
                             calibrate-kdf.ts
  test/                    node --test suites (see Testing)
  docs/                    ARCHITECTURE_RESEARCH.md, FRONTEND_INTEGRATION.md
  electron.vite.config.ts  Builds main + preload only (renderer is the frontend)
  electron-builder.yml     Packaging + signing config (electron-builder 26.x)
```

## Build

```bash
npm run build        # electron-vite build (main + preload) + build-renderer.sh
```

`npm run build:shell` builds only main + preload; `npm run build:renderer:frontend`
builds only the frontend into `out/renderer`. Preview the bundle with
`npm run preview`.

## Packaging and signing

Build the platform installer with electron-builder (26.x GA). Each target runs
the build first, then `electron-builder`:

```bash
npm run dist:mac     # dmg + zip, arm64 + x64
npm run dist:win     # nsis, x64 + arm64
npm run dist:linux   # AppImage + deb + rpm, x64
```

`@node-rs/argon2` ships per-arch prebuilds, and npm installs only the current
host's, so build each target on its own arch: cross-building (e.g. a Windows
installer from Linux) would package the wrong `.node` and fail to load the
signer's crypto at runtime. For the same reason, produce the `win` arm64 slice on
an arm64 host (the x64 host lacks the arm64 argon2 prebuild). The Linux `rpm`
target additionally needs `rpmbuild` on PATH; without it, `AppImage` + `deb`
still build.

macOS builds additionally need the signed keychain helper. Build it before
`dist:mac` or the app falls back to password-only unlock:

```bash
npm run build:keychain-helper   # native/macos-keychain/build.sh -> resources/qrl-keychain-helper
```

### Environment each signing step needs

Signing is wired through three electron-builder hooks (declared in
`electron-builder.yml`). Each reads its credentials from the environment; nothing
is committed.

| Step | Hook | Env required |
|---|---|---|
| macOS notarization | `afterSign` -> `scripts/notarize.cjs` | `APPLE_API_KEY` (path to the `.p8`), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, and `APPLE_TEAM_ID`. The `.app` is signed from the login keychain identity (`CSC_NAME`); notarytool staples the ticket. |
| Windows Authenticode | `signtoolOptions` in `electron-builder.yml` | `WIN_CSC_LINK` (path or base64 of the `.pfx`) and `WIN_CSC_KEY_PASSWORD`. For EV / cloud-HSM certs, use a custom `signtoolOptions.sign` hook instead. |
| PGP detached signatures | `afterAllArtifactBuild` -> `scripts/pgp-sign.cjs` | `GPG_KEY_ID` (the key to detach-sign each artifact, producing `.asc` sidecars, as Railway Wallet does). |

`@electron/fuses` are flipped on the packaged binary in `afterPack` (before
signing). Verify the result on a built app with `npm run fuses:read`.

## Security model at a glance

- The mandatory Argon2id-derived password is the load-bearing control. Even if
  every OS app-binding layer is defeated by same-user malware, the attacker
  still only gets an Argon2id-hardened, AES-256-GCM-sealed blob.
- OS app-binding (macOS Keychain bound to the Designated Requirement + Touch ID;
  Windows/Linux `safeStorage`) is defense-in-depth: it raises attacker cost and
  generates detection signal. It is NOT a guarantee. Same-context code execution
  defeats it (see the Chrome ABE bypass history in the threat model).
- The renderer is fully sandboxed and key-free. Containment controls:
  `contextIsolation`, `sandbox`, `nodeIntegration: false`, a strict CSP
  (`default-src 'self'`, `script-src 'self'` with no inline/eval) delivered as a
  real `file://` response header, the file handler contained to the app bundle,
  IPC sender + schema validation, navigation lockdown with a trusted-host
  allowlist for external links, deny-by-default renderer permissions,
  `@electron/fuses`, and ASAR integrity.
- The signer is the sole key holder, runs in an isolated `utilityProcess`, and
  zeroizes every secret buffer on its way out.

Full detail: [`SECURITY.md`](SECURITY.md) and [`THREAT_MODEL.md`](THREAT_MODEL.md).

## Testing

`npm test` runs `node --test --import tsx` over `test/*.test.ts` (no Electron,
no network). The suites exercise the load-bearing signer logic directly:

- `signer.crypto.test.ts` - Argon2id KDF determinism, AES-256-GCM round-trip +
  tamper rejection, `signMessage` -> ML-DSA-87 verify, and the create op
  (a generated wallet signs and verifies).
- `signer.tx.test.ts` - `signTransaction` produces a type-2 raw tx fully offline
  (proves the `networkId`-offline path so signing needs no provider), binds the
  signature to `chainId`, and refuses a tx whose `from` is not the unlocked account.
- `signer.session.test.ts` - the unlock lifecycle: correct-password unlock,
  `withSeed` yields exactly the stored seed, wrong-password authentication
  failure, `lock()` teardown, and the autolock timer firing (mock timers).
- `schemas.test.ts` - the IPC boundary (invariant #4): every request schema
  accepts valid input and rejects malformed / oversized / extra-keyed payloads,
  including the multi-wallet arms (import mnemonic-XOR-hexseed, unlock /
  removeWallet / setActiveWallet) and the hex-seed identity round-trip.
- `rpc.fees.test.ts` - the EIP-1559 fee-level math (pure bigint, no network).
- `externalLinks.test.ts` - the trusted-host allowlist for `openExternal`.
- `security.permissions.test.ts` - deny-by-default renderer permission handlers.

What the node suite cannot cover (it has no Electron runtime): IPC sender
validation, the confirmation modal, the signer fork/correlation in
`signerBridge`, and the keychain vaults. Exercise those via the manual
acceptance scenarios in `CLAUDE.md` section 6.

## Validation gates

Per the workspace `CLAUDE.md`, run and report these before proposing a
merge/push/release. They are the minimum gate for this repo:

```bash
npm run format:check   # prettier --check (CI fails on formatting drift)
npm run lint           # eslint, --max-warnings 0
npm run typecheck      # tsc --noEmit, strict
npm test               # node --test via tsx
npm run build          # electron-vite build + build-renderer.sh
```

Additional checks worth running for a release:

```bash
npm run calibrate:kdf  # re-benchmark Argon2id on the target hardware
npm run fuses:read     # confirm @electron/fuses on a packaged build
```
