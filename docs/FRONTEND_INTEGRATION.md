# Reusing myqrlwallet-frontend as the renderer

The bundled renderer is the `myqrlwallet-frontend` React app, built into
`out/renderer/` by `scripts/build-renderer.sh`. Desktop signing and unlock
operations call `window.qrlWallet.*`, which routes to the isolated signer.
Import forms can handle recovery material while provisioning an account;
ongoing seed decryption and signing stay in the signer process. This document
describes the integration and its bridge contract.

## Two required source changes (frontend repo)

These two changes make the SPA load and route correctly from `file://` under
`loadFile`. They are small and self-contained.

### 1. `config/vite.config.ts`: add `base: './'`

Assets must resolve relative to the loaded `file://` document, not from `/`.

```ts
// config/vite.config.ts
export default defineConfig({
  base: './',          // ADD: relative asset base for file:// (loadFile)
  // ...existing config
});
```

(This mirrors the desktop's own `electron.vite.config.ts`, which already sets
`base: './'` on its renderer target.)

### 2. `src/router/router.tsx`: `createBrowserRouter` -> `createHashRouter`

`createBrowserRouter` relies on the History API and clean URL paths, which do not
work under `file://`. Hash routing does.

```ts
// src/router/router.tsx
// BEFORE:
import { createBrowserRouter, RouterProvider } from "react-router-dom";
const router = createBrowserRouter([ /* routes */ ]);

// AFTER:
import { createHashRouter, RouterProvider } from "react-router-dom";
const router = createHashRouter([ /* routes unchanged */ ]);
```

The route table itself does not change.

## CSP: strict header from the file-protocol handler, meta tag rewritten at build

The frontend's `index.html` ships a meta CSP tuned for its web hosting
(`script-src` includes `'unsafe-inline'`, `connect-src` allows
`http://localhost:*`); on the web, nginx's strict header is the real control.
On the desktop, `webRequest.onHeadersReceived` does not reliably fire for
`file://` document loads, so the strict policy is delivered as a REAL response
header by the file-protocol handler (`protocol.handle('file')` in
`src/main/index.ts`, policy built by `src/main/security.ts`
`buildContentSecurityPolicy`) with NO script `unsafe-inline` and NO
`unsafe-eval`. As defense-in-depth, `scripts/build-renderer.sh` rewrites the
staged renderer's meta CSP to the same desktop policy, so both the header and
the meta tag enforce `script-src 'self' 'wasm-unsafe-eval'` (WebAssembly
compilation only, for the frontend's hash-wasm argon2id keystore import; JS
`eval` stays blocked).

This works because a Vite + React build emits a single hashed external
stylesheet and external script chunks, so `script-src 'self'` is satisfiable:
no inline event handlers, no inline `<script>`. (`style-src` keeps
`'unsafe-inline'` for Radix's runtime style attributes; inline style cannot
execute code.)

Any RPC / relay / backend origins the frontend needs at runtime must be added to
`connect-src` in `src/main/config.ts` (`connectSrcOrigins()`), since the strict
CSP only permits `'self'` plus the configured origins.

## Refactor the in-renderer crypto call sites

These are the call sites that currently materialise key material in the renderer.
Each must be rerouted to `window.qrlWallet.*`. After this refactor, the
frontend's crypto worker and `WalletEncryptionUtil` are no longer on the
spend/unlock path in the desktop build.

| Frontend call site | Today (in renderer) | Desktop: delegate to |
|---|---|---|
| `src/stores/qrlStore.ts` (around the `signTransaction` path, lines ~583/587) | `deriveHexSeedAsync(mnemonic)` then `qrlInstance.accounts.signTransaction(txObject, privateKey)` | `window.qrlWallet.buildTransaction(...)` then `window.qrlWallet.requestSignature({ kind: 'transaction', tx })`, then `window.qrlWallet.sendRawTransaction({ rawTx })` |
| `src/components/Core/Body/DAppConnect/DAppApprovalModal.tsx` | `WalletEncryptionUtil.decryptSeedWithPin(...)` -> `hexSeed`, then `web3.accounts.signTransaction` / `signMessage` / `signTypedData` (lines ~100, ~239) | `window.qrlWallet.requestSignature({ kind: 'transaction' \| 'message' \| 'typedData', ... })` |
| `src/utils/crypto/walletEncryption.ts` (`WalletEncryptionUtil`) | encrypt/decrypt seed under PIN in-page | not called on the desktop spend/unlock path; unlock becomes `window.qrlWallet.unlock(...)`, import becomes `window.qrlWallet.importWallet(...)` |
| `src/utils/crypto/cryptoWorker.ts` / `cryptoWorkerClient.ts` (`deriveHexSeed` worker) | derives the hex seed from the mnemonic in a web worker | not called on the desktop path; derivation happens in the signer (`src/signer/signing.ts`) |
| `src/utils/signing/*` (`sign.ts`, `messageDigest.ts`, `typedData.ts`, `ctx.ts`) | computes digests + ML-DSA-87 signatures in-page | the isolated signer computes message and typed-data digests and signatures with canonical fixture parity. |

The signer reproduces the audited path byte-for-byte: it shares the same
`SCHEME` context tags and `MLDSA87` sizes (`src/shared/constants.ts`) and mirrors
`src/utils/signing/sign.ts` + `qrlStore.sendTransaction`, so a desktop-produced
signature verifies identically to a web-wallet one.

## Multi-wallet + import routes (bridge contract v2)

The desktop stores any number of wallets (one encrypted envelope per address,
each under its own password, in `userData/wallet/seeds/<address>.json`) with a
single ACTIVE account and at most one unlocked signer session. The bridge
surface for the frontend:

- `importWallet({ mnemonic, password, useKeychain? })` OR
  `importWallet({ hexSeed, password, useKeychain? })`: exactly one source. The
  hex seed is the web wallet's 51-byte "hex seed" import; the signer
  regenerates the canonical mnemonic so both routes store an identical
  envelope. Importing/creating no longer requires removing the previous wallet:
  a new account is ADDED and becomes active. A duplicate address is rejected
  with "this account is already on this device".
- `listWallets(): { wallets: [{ address, keychainBacked }], active }`.
- `setActiveWallet({ address })`: switches the active account. When the session
  belongs to a different account it is dropped and the NATIVE unlock window is
  raised (with an account picker when more than one wallet exists); each wallet
  unlocks with its own password.
- `removeWallet({ address }?)`: removes ONE wallet (the active one when
  argless, back-compat). Gated by the trusted main-drawn confirmation, which
  names the address.
- `getStatus()` now also carries `wallets` and `activeAddress`.
- Encrypted-wallet-file restore needs NO desktop intake: decrypt the file in
  the import form exactly as the web build does (import-time secrets pass
  through the renderer on every route, including typed mnemonics), then hand
  the recovered mnemonic or hexSeed to `importWallet`.

Frontend wiring expected on desktop: un-hide the hex-seed and encrypted-wallet
import tabs, route `setActiveAccount` through `setActiveWallet`, drive the
account list from `listWallets`, and pass the removed address to
`removeWallet`.

### Typed-data signing

`window.qrlWallet.requestSignature({ kind: 'typedData', payload, signer, origin })`
uses the existing `DAppApprovalModal` adapter. Main validates the complete
bounded payload and draws its own field summary before approval. The isolated
signer selects QRL-SIGN-TYPED v2 when an address type is reachable and v1 for
address-free data, then returns signature, public key, descriptor, account,
digest and scheme version. The renderer's existing adapter adds `payload.domain`
to the Connect response. Both boundaries enforce account binding. The shared
renderer retains its older unsupported-method wording on the error path; valid
requests use the success path without frontend changes.

## Adapter sketch: delegate the existing signing service

The cleanest migration is a thin adapter that exposes the same shape the
frontend's signing code already calls, but routes to `window.qrlWallet`. This
lets you swap the implementation at one import site rather than rewriting every
caller.

```ts
// src/adapters/desktopSigner.ts  (in the frontend, desktop build only)
//
// Mirrors the call shape of src/utils/signing + qrlStore.sendTransaction, but
// the seed never enters the renderer: every operation routes to the isolated
// signer via window.qrlWallet. No deriveHexSeed, no WalletEncryptionUtil.

import type { UnsignedTransaction } from "...shared/schemas"; // shape only

const api = window.qrlWallet;

export const desktopSigner = {
  async signAndSendTransaction(params: {
    from: string;
    to: string;
    value: string;            // smallest unit, decimal string
    data?: string;
    feeLevel?: "low" | "medium" | "high";
  }): Promise<{ transactionHash: string }> {
    // 1. Build (nonce/gas/chainId filled by main from RPC).
    const tx: UnsignedTransaction = await api.buildTransaction(params);
    // 2. Confirm in the trusted main-drawn modal + sign in the signer.
    const sig = await api.requestSignature({ kind: "transaction", tx });
    // 3. Broadcast the raw signed tx.
    if (!sig.rawTransaction) throw new Error("no raw transaction returned");
    return api.sendRawTransaction({ rawTx: sig.rawTransaction });
  },

  // qrl_signMessage: the renderer hands over the message bytes only.
  async signMessage(messageHex: string, signer: string) {
    return api.requestSignature({ kind: "message", messageHex, signer });
    // -> { signature, publicKey, descriptor, signer, digest, schemeVersion }
  },

  // Session lifecycle replaces in-page PIN decrypt / encrypt.
  unlock(password?: string) {
    return api.unlock({ password });          // omit password -> OS keychain (macOS)
  },
  lock() {
    return api.lock();
  },
  importWallet(mnemonic: string, password: string, useKeychain = false) {
    return api.importWallet({ mnemonic, password, useKeychain });
  },
  getStatus() {
    return api.getStatus();
  },
  onLockStateChanged(cb: (locked: boolean) => void) {
    return api.onLockStateChanged(cb);        // returns an unsubscribe
  },
};
```

Wiring it in: in `qrlStore.ts`, replace the `deriveHexSeedAsync` +
`accounts.signTransaction` block with `desktopSigner.signAndSendTransaction(...)`;
in `DAppApprovalModal.tsx`, replace the `decryptSeedWithPin` + `web3.accounts.*`
calls with `desktopSigner.signMessage` / `signAndSendTransaction`. The PIN-entry
UX becomes a call to `desktopSigner.unlock(password)`, and the autolock state can
drive the UI via `onLockStateChanged`.

## Build the bundled renderer

Desktop 1.4.4 uses frontend main revision
`683d0642f2b91b9e70c61e56989bddc4ff4b1ab0`, the web wallet released on 2026-10-24.
This includes English, German, Spanish, Russian and Simplified Chinese catalogs,
the dApp approval visibility gate, the typed-data chain check and the frontend
zod fix. `.github/workflows/ci.yml` pins the same full revision.

`scripts/build-renderer.sh` (run via `npm run build:renderer:frontend`) resolves
the frontend checkout, installs its locked dependencies, builds it and stages
the output for `loadFile`. For a release build, set `QRL_FRONTEND_DIR` to a
detached checkout of the revision above. The script also supports the sibling
frontend checkout for development. The pinned source includes the asset and
routing adaptations described above.

After swapping the renderer, re-run the validation gates from the README
(`format:check`, `lint`, `typecheck`, `test`, `build`) before packaging.
