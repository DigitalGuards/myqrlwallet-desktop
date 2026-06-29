# MyQRLWallet Desktop

Post-quantum, self-custody QRL desktop wallet. An Electron shell built around a
hardened four-process architecture: a sandboxed renderer (the reused
`myqrlwallet-frontend` React app), a broker main process, and an isolated signer
`utilityProcess` that is the sole holder of plaintext key material.

This implements the decision document in
[`docs/ARCHITECTURE_RESEARCH.md`](docs/ARCHITECTURE_RESEARCH.md). Read that first
for the "why"; this README is the "how to run/build" companion. The honest
security tradeoffs are in [`THREAT_MODEL.md`](THREAT_MODEL.md) and the
renderer-hardening checklist as-built is in [`SECURITY.md`](SECURITY.md).

## At a glance

- **Stack:** Electron 33 + electron-vite + electron-builder 26 (GA), TypeScript (strict), React 19 renderer.
- **Post-quantum signing:** Halborn-audited `@theqrl/mldsa87` (ML-DSA-87 / FIPS 204, NIST Level 5), run ONLY inside the isolated signer process.
- **Key at rest:** Argon2id (`@node-rs/argon2`) password-derived KEK + AES-256-GCM, with the macOS Keychain (Designated Requirement + Touch ID) as defense-in-depth.
- **Status:** scaffold. All gates green (typecheck, lint, format, build, tests) and adversarially security-reviewed; residual risks are tracked honestly in [`THREAT_MODEL.md`](THREAT_MODEL.md).

## Quick start

```bash
nvm use            # Node 20.19.0 (.nvmrc)
npm install        # legacy-peer-deps is preconfigured
npm run dev        # launch the hardened shell + demo renderer
```

Run the full gate suite anytime:

```bash
npm run typecheck && npm run lint && npm run format:check && npm test && npm run build
```

## What works today

- Wallet provisioning (import a mnemonic, encrypt + persist the seed), password unlock, and macOS Touch-ID / keychain unlock.
- Balance reads and unsigned type-2 (EIP-1559) transaction assembly via the bundled RPC proxy.
- Transaction signing (fully offline) and message signing (`qrl_signMessage`), each gated by the trusted main-drawn confirmation modal and byte-faithful to the web wallet, so signatures verify identically.
- Auto-lock with renderer lock-state events, and broadcast of the signed raw transaction.

Typed-data signing (`qrl_signTypedData`) is intentionally fast-failed until its byte-exact hasher is ported (see [`docs/FRONTEND_INTEGRATION.md`](docs/FRONTEND_INTEGRATION.md)); it never signs a digest the dApp side could not reproduce.

## Architecture: four processes, one trust gradient

Trust runs lowest to highest. Key material never moves down the gradient.

| Process | Trust | Has Node? | Holds keys? | Responsibility |
|---|---|---|---|---|
| Renderer | Lowest (treated as fully untrusted) | No (`sandbox: true`, `nodeIntegration: false`) | No | The React UI. Talks only through `window.qrlWallet`. A full renderer RCE yields no key material because none lives here. |
| Preload | Bridge | No (tiny allowlist) | No | Mounts the narrow `window.qrlWallet` API over `contextBridge`. No raw `ipcRenderer`, no `require`. |
| Main (broker) | Mid | Yes | No (plaintext) | Window lifecycle, IPC sender + schema validation, the trusted confirmation modal, the RPC proxy, and the encrypted seed file on disk. |
| Signer (`utilityProcess`) | Highest, most isolated | Yes | Yes, transiently | The ONLY place the mnemonic, hex seed, and ML-DSA-87 secret key are ever materialised. Argon2id KDF, AES-256-GCM decrypt, sign, zeroize. Speaks only to main over `parentPort`; the renderer has no handle to it. |

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
    main/          Broker: index.ts (entry), ipc.ts (handlers), security.ts
                     (CSP, sender validation, navigation lockdown), config.ts
                     (RPC defaults, autolock), confirm.ts (trusted modal),
                     rpc.ts (proxy), seedFile.ts (encrypted seed at rest),
                     signerBridge.ts (fork + request/response to the signer)
    signer/        Isolated highest-trust process: index.ts (entry), kdf.ts
                     (Argon2id), aead.ts (AES-256-GCM), signing.ts (ML-DSA-87 +
                     web3 tx signing), session.ts (in-memory unlock + autolock),
                     zeroize.ts (buffer wipe)
    keyvault/      OS app-binding (defense-in-depth): macKeychainVault.ts
                     (Touch ID, DR-bound), safeStorageVault.ts (DPAPI/libsecret,
                     no presence gate), nullVault.ts (password every unlock),
                     factory.ts (selects strongest available)
    renderer/      The demo renderer (index.html + src/). Swappable for the real
                     frontend: see docs/FRONTEND_INTEGRATION.md
  native/macos-keychain/   Swift keychain helper source + build.sh
  resources/               Built helper lands here, copied into the .app bundle
  scripts/                 Packaging hooks (afterPack/notarize/pgp-sign),
                             calibrate-kdf.ts, build-renderer.sh
  docs/                    ARCHITECTURE_RESEARCH.md, FRONTEND_INTEGRATION.md
  electron.vite.config.ts  Three build targets -> out/{main,preload,renderer}
  electron-builder.yml     Packaging + signing config (electron-builder 26.x)
```

## Prerequisites

- Node `>=20.19.0`. The repo pins `20.19.0` in `.nvmrc`; run `nvm use`.
  (Node 20.19 is required because the signer relies on a global WebCrypto RNG.)
- A C/C++ toolchain is NOT required: `@node-rs/argon2` and `@theqrl/*` are
  pure-NAPI / pure-JS. NAPI is ABI-stable across Node and Electron, so there is
  no `electron-rebuild` step.

## Install

```bash
nvm use            # picks up .nvmrc (20.19.0)
npm install
```

The repo ships an `.npmrc` with `legacy-peer-deps=true`. This is required: the
React 19 peer ranges across the `@theqrl` stack need it, matching the
`myqrlwallet-frontend` install. Do not drop it.

## Dev

```bash
npm run dev        # electron-vite dev: HMR renderer + main + signer
```

In dev the renderer loads from the Vite dev server (`ELECTRON_RENDERER_URL`) and
the CSP is widened just enough to allow that origin plus its HMR websocket.
Production ALWAYS uses `loadFile` over `file://`, never a remote URL.

## Build

```bash
npm run build      # electron-vite build -> out/{main,preload,renderer}
```

This produces the runnable bundle but does not package an installer. Preview it
with `npm run preview`.

## Packaging and signing

Build the platform installer with electron-builder (26.x GA). Each target runs
the build first, then `electron-builder`:

```bash
npm run dist:mac     # dmg + zip, arm64 + x64
npm run dist:win     # nsis, x64 + arm64
npm run dist:linux   # AppImage + deb + rpm, x64
```

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
  (`default-src 'self'`, no `unsafe-inline`, no `unsafe-eval`), IPC sender +
  schema validation, navigation lockdown, `@electron/fuses`, and ASAR integrity.
- The signer is the sole key holder, runs in an isolated `utilityProcess`, and
  zeroizes every secret buffer on its way out.

Full detail: [`SECURITY.md`](SECURITY.md) and [`THREAT_MODEL.md`](THREAT_MODEL.md).

## Reusing the web frontend as the renderer

The bundled `src/renderer/` is a minimal demo. The intended renderer is the real
`myqrlwallet-frontend` React app, swapped in with two source changes and a
refactor of its in-page crypto call sites to delegate to `window.qrlWallet`.
Step-by-step: [`docs/FRONTEND_INTEGRATION.md`](docs/FRONTEND_INTEGRATION.md).

## Validation gates

Per the workspace `CLAUDE.md`, run and report these before proposing a
merge/push/release. They are the minimum gate for this repo:

```bash
npm run format:check   # prettier --check (CI fails on formatting drift)
npm run lint           # eslint, --max-warnings 0
npm run typecheck      # tsc --noEmit, strict
npm test               # node --test via tsx
npm run build          # electron-vite build
```

Additional checks worth running for a release:

```bash
npm run calibrate:kdf  # re-benchmark Argon2id on the target hardware
npm run fuses:read     # confirm @electron/fuses on a packaged build
```
