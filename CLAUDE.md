# CLAUDE.md

This file defines strict operating rules for coding agents working in
`/home/waterfall/myqrlwallet/myqrlwallet-desktop`, the post-quantum QRL desktop
wallet (Electron). It inherits the workspace root rules in
`/home/waterfall/myqrlwallet/CLAUDE.md`; where they conflict, the more specific
rule here wins for files under this repo.

## 0. Priority Order

1. Follow explicit user instructions.
2. Preserve the security invariants in section 4 (do not regress key isolation).
3. Maintain momentum: implement, validate, and finish end-to-end.

If rules conflict, follow the highest item.

## 1. Execution Contract (Mandatory)

### 1.1 Default behavior
- Do the work. Do not stop at advice unless the user explicitly asks for planning only.
- For multi-step tasks, complete implementation + verification in one pass when feasible.
- Do not leave TODOs for obvious next steps you can execute now.
- Treat the already-written CORE (`src/shared/*`, `src/main/*`, `src/signer/*`,
  `src/keyvault/*`, `src/preload/index.ts`) as the contract. Match exports,
  types, channel names, and the `window.qrlWallet` shape exactly. Do not rewrite
  it to suit new code; make new code conform to it.

### 1.2 Review requests
When the user asks for a "review":
- Use code-review mode by default.
- Output findings first, ordered by severity, each with file path + line reference.
- Treat any regression of a section 4 invariant as the highest severity.
- If no findings, say so explicitly and list residual risks/testing gaps.

### 1.3 Validation gates
Run and report these in this repo before proposing a merge or release. They are
the project's CI gates and are cheap to run locally:

```bash
npm run format:check   # prettier --check (CI fails on formatting drift)
npm run lint           # eslint . --max-warnings 0
npm run typecheck      # tsc --noEmit (strict; see 1.4)
npm test               # node --test over test/*.test.ts
npm run build          # electron-vite build (out/main, out/preload, out/renderer)
```

- A release-grade change is not "done" until `npm run build` is green. Builds
  MUST run before proposing a `dist`/sign/notarize step.
- For a packaged build, additionally exercise the `dist*` scripts only when the
  signing/notarize/PGP environment (section 5) is present.
- If a command cannot run, state exactly what was attempted and why.

### 1.4 Strict typing
`tsconfig` is hardened: target ES2022, `verbatimModuleSyntax: true`,
`noUncheckedIndexedAccess: true`. New code must typecheck under it.
- Use `import type` / `export type` for type-only imports (verbatimModuleSyntax).
- Indexed access is `T | undefined`; narrow before use.
- WebCrypto/Node crypto buffers fed to `crypto.subtle` need `Uint8Array<ArrayBuffer>` typing.

### 1.5 Response quality
- Be concrete: include exact commands run and a results summary.
- Avoid vague "should be fine" language. Distinguish facts from assumptions.
- When uncertain, run a command and verify instead of guessing.

## 2. Workspace Map (`src/` layout)

| Dir | Purpose |
|---|---|
| `src/shared/` | Cross-process, dependency-free contract: `constants.ts` (IPC channels, EVENTS, `BRIDGE_KEY='qrlWallet'`, MLDSA87 sizes, KDF_DEFAULTS, SCHEME, AEAD), `schemas.ts` (zod schemas + inferred request/result types), `bridge.ts` (`QrlWalletApi` + `window.qrlWallet` augmentation), `protocol.ts` (private main<->signer message types). Keep pure data; no side effects. |
| `src/main/` | The broker (lowest-but-trusted). `index.ts` (window + lifecycle + qrlconnect:// protocol handling), `ipc.ts` (the renderer's entire reachable surface), `security.ts` (CSP, sender validation, navigation lockdown, hardened webPreferences), `config.ts` (RPC defaults, autolock), `confirm.ts` (trusted signature modal, incl. the unverified dApp-origin block), `dappUri.ts` (qrlconnect URI shape validation, rate limit, cold-start buffer), `rpc.ts`, `seedFile.ts` (owns the encrypted seed on disk), `signerBridge.ts` (parent side of the signer channel). Holds NO plaintext keys. |
| `src/signer/` | The isolated `utilityProcess`, the ONLY holder of plaintext key material. `index.ts` (entry, speaks only over `process.parentPort`), `kdf.ts` (Argon2id KEK), `aead.ts` (AES-256-GCM envelope), `signing.ts` (seed derivation + ML-DSA-87), `session.ts` (in-memory unlock + autolock), `zeroize.ts`. |
| `src/keyvault/` | OS-keychain KEK storage. `factory.ts`/`index.ts` (resolution), `macKeychainVault.ts` (Touch-ID/keychain helper), `safeStorageVault.ts` (opt-in, no presence gate), `nullVault.ts`. |
| `src/preload/` | `index.ts` (the `window.qrlWallet` contextBridge for the wallet window) and `preload.ts` for the unlock window (built to `out/preload/unlock.js`). Exposes ONLY narrow named wrappers; never raw `ipcRenderer`. |
| `src/unlock/` | The native, app-owned UNLOCK window: its own small React renderer (`index.html` + `main.tsx` + `unlock.css`) and preload, shown by main (`src/main/unlockWindow.ts`) whenever the signer is locked. The MAIN wallet renderer is NOT here: it is the external `myqrlwallet-frontend`, built in by `scripts/build-renderer.sh` into `out/renderer`. There is no `src/renderer/` demo any more (deleted). |
| `scripts/` | `calibrate-kdf.ts`, `build-renderer.sh`, build hooks (`afterPack.cjs`, `notarize.cjs`, `pgp-sign.cjs`). |
| `native/macos-keychain/` | Swift keychain helper sources; `build.sh` emits the signed binary into `resources/`. |
| `test/` | `node --test` suites over the contract and signer logic. |

## 3. Git discipline

- **Branching: `dev` is the integration branch (and GitHub default); `main` is
  stable/release.** Do code work on short-lived feature branches and open a PR to
  `dev`; process PR and bot review comments (REST: `gh api
  repos/DigitalGuards/myqrlwallet-desktop/pulls/{n}/comments`) before merge. Cut
  `dev` -> `main` PRs for releases. Do not push code straight to `main`.
- Never revert user changes you did not author unless explicitly asked.
- Avoid destructive commands (`reset --hard`, `checkout --`) unless requested.
- Use non-interactive git. Keep commits scoped and descriptive.
- Docs-only prose changes may be committed directly to `dev`; code changes follow
  the PR-to-`dev` flow above.

## 4. Canonical security invariants (do not regress)

This is the load-bearing contract of the desktop wallet, the analogue of the
root file's dApp-connect canonical section. Treat any regression here as the
highest-priority bug. The cardinal property: even a fully compromised renderer
yields NO key material, because keys never live there.

1. **Signer is the sole key holder.** The signer `utilityProcess` is the ONLY
   process in which the mnemonic, seed, or ML-DSA-87 secret key is ever
   materialised. The renderer and the main process never hold the seed or
   secret key. Main brokers and owns the encrypted seed file; it never decrypts
   it. Files: `src/signer/index.ts`, `src/signer/session.ts`,
   `src/signer/signing.ts`, `src/main/signerBridge.ts`, `src/main/seedFile.ts`.

2. **Renderer webPreferences stay hardened.** `contextIsolation: true`,
   `nodeIntegration: false`, `sandbox: true` (plus `nodeIntegrationInWorker`/
   `InSubFrames: false`, `webSecurity: true`, `experimentalFeatures: false`).
   DevTools off in packaged builds. File: `src/main/security.ts`
   (`hardenedWebPreferences`), consumed in `src/main/index.ts`.

3. **Preload exposes only the narrow API.** The contextBridge mounts ONLY the
   named `window.qrlWallet` wrappers (`getBalance`, `buildTransaction`,
   `requestSignature`, `unlock`, `lock`, `removeWallet`, `getStatus`,
   `hasWallet`, `createWallet`, `importWallet`, `listWallets`,
   `setActiveWallet`, `sendRawTransaction`, `dappRequestAttention`,
   `openDesktopSettings`, `onLockStateChanged`, `onDAppConnectUri`). The unlock
   window's preload exposes only `window.unlockBridge`
   (`getInfo`/`submit`/`biometric`); the settings window's preload exposes only
   `window.settingsBridge` (`get`/`set`/`action`). Never expose raw
   `ipcRenderer`, `invoke`, channel strings, or Node primitives.
   Files: `src/preload/index.ts`, `src/unlock/preload.ts`,
   `src/settings/preload.ts`, `src/shared/bridge.ts`, `src/shared/constants.ts`.

4. **Every IPC handler validates sender AND argument.** Each `ipcMain.handle`
   first calls `isTrustedSender` (top frame of the wallet window + `file:`
   origin, sub-frames rejected) and then zod-parses its argument (reject
   malformed / oversized / extra-keyed) before acting. Files:
   `src/main/ipc.ts`, `src/main/security.ts` (`isTrustedSender`),
   `src/shared/schemas.ts`.

5. **Destructive renderer-reachable ops require the trusted main-drawn
   confirmation.** `REQUEST_SIGNATURE` (signing) and `REMOVE_WALLET` (the
   irreversible wipe) each proceed only after a main-drawn confirmation
   (`confirmSignature` / `confirmRemoveWallet`) returns approved; a rejection
   throws and nothing is signed or deleted. The renderer's own confirm UI is
   convenience, never the gate. The unlock password is collected in the native
   unlock window (`src/unlock/`, `src/main/unlockWindow.ts`), not the renderer.
   Files: `src/main/ipc.ts`, `src/main/confirm.ts`, `src/main/unlockWindow.ts`.

6. **Strict CSP: `script-src 'self'`, no script `unsafe-inline` / `unsafe-eval`.**
   The load-bearing control is `script-src 'self'`: a renderer RCE can neither
   inject nor `eval` script. Full policy: `default-src 'self'`;
   `script-src 'self'`; `style-src 'self' 'unsafe-inline'` (the reused frontend's
   Radix UI sets inline STYLE attributes at runtime; inline style cannot execute
   code, so this is an accepted, much-lower-risk relaxation than inline script);
   explicit `connect-src` from the configured RPC/backend origins only;
   `img-src 'self' data: https:`; `media-src 'self' blob:`; `font-src 'self' data:`;
   `object-src 'none'`; `frame-ancestors 'none'`; `base-uri 'self'`;
   `form-action 'self'` (`'self'` resolves to `file://` here, so effectively
   `'none'`); `worker-src 'self' blob:`. Delivered as a REAL response header on
   every `file://` response by the file-protocol handler
   (`protocol.handle('file')` in `src/main/index.ts`), because
   `webRequest.onHeadersReceived` does not reliably fire for `file://` document
   loads; the webRequest install covers http(s) (dev server) responses, and
   `scripts/build-renderer.sh` rewrites the built renderer's meta CSP to the
   same policy as defense-in-depth. Files: `src/main/security.ts`
   (`buildContentSecurityPolicy`, `installContentSecurityPolicy`),
   `src/main/index.ts` (`installFileProtocolHandler`), `src/main/config.ts`
   (`connectSrcOrigins`), `scripts/build-renderer.sh`. Renderer permissions are
   deny-by-default except clipboard write (`src/main/permissions.ts`,
   `installPermissionHandlers`).

7. **KDF params are frozen once seeds exist.** `KDF_DEFAULTS` and `AEAD` in
   `src/shared/constants.ts` are persisted with every encrypted seed; changing
   `algorithm`, `version`, `memoryCost`, `timeCost`, `parallelism`, `outputLen`,
   `saltBytes`, or the AEAD shape breaks decryption of existing wallets.
   Re-benchmark with `npm run calibrate:kdf` and freeze; do not edit casually.

8. **Fuses + ASAR integrity stay on in packaged builds.** `@electron/fuses`
   (`afterPack.cjs`) and ASAR integrity must remain enabled. `asarUnpack`
   covers `**/*.node` only (the NAPI prebuilds). Do not disable fuses or
   integrity to work around a packaging error. Files: `scripts/afterPack.cjs`,
   `electron-builder.yml`. Verify with `npm run fuses:read`.

9. **Crypto stays behind the signer modules.** All key derivation, AEAD, and
   signing live in `src/signer/kdf.ts`, `src/signer/aead.ts`,
   `src/signer/signing.ts`. No crypto in the renderer; no ad-hoc crypto in main
   beyond brokering. `@node-rs/argon2` and `@theqrl/*` are pure NAPI/JS (ABI
   stable), so NO `electron-rebuild` is needed.

## 5. Build, sign, notarize, PGP

electron-builder is **26.x GA**: top-level `mac.*` keys and `win.signtoolOptions`
(NOT the v27 `.sign` object shape). Hooks: `afterPack` (fuses), `afterSign`
(notarize), `afterAllArtifactBuild` (PGP detach-sign).

- **Renderer**: `npm run build:renderer:frontend` (run by `npm run build`)
  builds the reused `myqrlwallet-frontend` into `out/renderer`; electron-vite
  additionally builds the native unlock window into `out/unlock`. This is a
  dev.qrlwallet.com STAGING build by default (env-overridable; see
  `scripts/build-renderer.sh`).
- **macOS**: run `npm run build:keychain-helper` BEFORE `dist:mac`, otherwise
  `resources/` is empty and the app silently falls back to password-only unlock
  (no Touch-ID). Signing identity from `CSC_NAME` / login keychain;
  hardenedRuntime + entitlements in `build/`. Notarization needs `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD` (or API key), and `APPLE_TEAM_ID` in env.
- **Windows**: `WIN_CSC_LINK` (path/base64 of the `.pfx`) + `WIN_CSC_KEY_PASSWORD`,
  or an EV / cloud-HSM hook. Authenticode SHA-256 + RFC-3161 timestamp.
- **PGP**: `pgp-sign.cjs` detach-signs every artifact to a `.asc` sidecar; needs
  the signing key available to `gpg` in the environment.
- Never commit or echo any signing secret, Apple password, or PGP key.

## 6. Required acceptance scenarios when touching the signer/IPC boundary

Exercise these (test or manual) for any change to `src/main/ipc.ts`,
`src/preload/`, `src/signer/`, `src/keyvault/`, or `src/main/security.ts`:

- Fresh import: `importWallet` (mnemonic OR hex extended seed) encrypts the
  seed, persists it under `wallet/seeds/<address>.json`, makes it active, opens
  a session.
- Second wallet: importing/creating another account keeps the first on disk,
  switches the active pointer, and `listWallets` reports both.
- Account switch: `setActiveWallet` to a different account drops the session
  and raises the native unlock window (with the account picker when more than
  one wallet exists); unlocking the picked account selects it.
- Password unlock: `unlock` with a password derives the KEK and opens a session.
- Keychain / Touch-ID unlock: `unlock` with no password retrieves the KEK from
  the OS vault; missing/declined vault falls back to requiring a password.
- Autolock: after `AUTOLOCK_MS` idle the signer zeroizes and emits
  `LOCK_STATE_CHANGED(true)` to the renderer.
- Transaction sign + broadcast: confirmation modal approve -> signer signs ->
  `sendRawTransaction` broadcasts the signed raw tx.
- Message / typed-data sign: `requestSignature` over the message/typedData arm
  of the discriminated union, with the correct SCHEME context tag.
- Lock + native unlock: a lock (sidebar Lock, autolock, or startup-if-locked)
  raises the native unlock window; a password (or keychain) unlock closes it and
  reopens the session.
- Remove wallet (wipe): `removeWallet` deletes that wallet's seed file and
  clears its keychain entry ONLY after the trusted main-drawn confirmation
  (which names the address). Removing the unlocked account drops the session
  and raises the unlock window when other wallets remain; after removing the
  LAST wallet the unlock window is NOT shown (nothing left to unlock).
- Locked-state rejection: signing/spend calls fail cleanly when no session is open.
- Malformed IPC rejection: a payload that fails zod parse is rejected before any action.
- Sub-frame sender rejection: an IPC event from a non-top frame or non-`file:`
  origin is rejected by `isTrustedSender`.
- dApp deep link (warm + cold start): a `qrlconnect://` launch surfaces the
  window and reaches the renderer's consent modal; declining produces zero
  relay traffic; a launch flood collapses to one prompt (rate limit).
- dApp signature provenance: a signature request carrying a schema-valid
  `origin` block renders the unverified dApp context in the trusted confirm;
  an oversized/control-char/extra-keyed origin is rejected at the boundary.

## 7. Style

- Concise, technical, action-oriented. Surface blockers immediately with a
  proposed resolution.
- **No em dashes, ever** (hard user mandate): not in UI copy, docs, READMEs,
  commit messages, PR descriptions, code comments, or chat replies. Use a colon,
  comma, period, parentheses, or hyphen. Remove existing ones on sight.

## 8. References

- `docs/ARCHITECTURE_RESEARCH.md`: the decision document this scaffold implements (four-process trust gradient, hardening checklist, packaging/signing rationale).
- `SECURITY.md`: security posture and reporting.
- `THREAT_MODEL.md`: trust boundaries, attacker model, residual risks (e.g. JS-string KEK lifetime).
- `FRONTEND_INTEGRATION.md`: how the reused `myqrlwallet-frontend` renderer binds to `window.qrlWallet`.
</content>
</invoke>
