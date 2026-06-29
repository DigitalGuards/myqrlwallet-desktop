# Reusing myqrlwallet-frontend as the renderer

The bundled `src/renderer/` is a minimal demo. The intended renderer is the real
`myqrlwallet-frontend` React app. The primary reuse win is the UI; the only
non-negotiable refactor is moving the in-page crypto call sites to delegate to
`window.qrlWallet`, so that NO key material lives in the renderer. This document
is the step-by-step.

The goal state: the frontend renders unchanged, but every place it would have
decrypted a seed or signed bytes in-page now calls `window.qrlWallet.*`, which
routes to the isolated signer. The renderer never sees a mnemonic, a hex seed, or
an ML-DSA-87 key again.

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

## CSP: drop the renderer's permissive meta tag, rely on the main-process header

The frontend's `index.html` currently ships a meta CSP that includes
`'unsafe-inline'` for `script-src` and `style-src` (needed for its web hosting).
The desktop's main process installs a strict header CSP on every response
(`src/main/security.ts` `installContentSecurityPolicy`) with NO `unsafe-inline`
and NO `unsafe-eval`. The header is authoritative for `file://`, and a meta CSP
can only ever tighten, never loosen, the header.

Two options:

- Preferred: remove the meta CSP from the frontend's `index.html` for the desktop
  build and rely entirely on the main-process header. This keeps a single source
  of truth and the strict policy wins.
- If the frontend must keep one meta CSP for both web and desktop, ensure it does
  not depend on `'unsafe-inline'` at runtime, because the header CSP forbids it.
  In practice a Vite + React build emits a single hashed external stylesheet and
  external script chunks, so `style-src 'self'` and `script-src 'self'` are
  satisfiable: no inline `<style>`, no inline event handlers, no inline `<script>`.

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
| `src/utils/signing/*` (`sign.ts`, `messageDigest.ts`, `typedData.ts`, `ctx.ts`) | computes digests + ML-DSA-87 signatures in-page | the signer mirrors this byte-for-byte; the renderer should not import these on the desktop build. (Note: typed-data signing is not yet wired in the signer; see below.) |

The signer reproduces the audited path byte-for-byte: it shares the same
`SCHEME` context tags and `MLDSA87` sizes (`src/shared/constants.ts`) and mirrors
`src/utils/signing/sign.ts` + `qrlStore.sendTransaction`, so a desktop-produced
signature verifies identically to a web-wallet one.

### Caveat: typed-data is not wired yet

`window.qrlWallet.requestSignature({ kind: 'typedData', ... })` currently fails
loudly in the signer (`src/signer/index.ts`) rather than emit a signature over a
digest the dApp side could not reproduce. Before enabling the `qrl_signTypedData`
path in `DAppApprovalModal.tsx`, port the byte-exact hasher from
`src/utils/signing/typedData.ts` into the desktop signer. `qrl_signMessage` and
`qrl_signTransaction` work today.

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
  async signMessage(messageHex: string) {
    return api.requestSignature({ kind: "message", messageHex });
    // -> { signature, publicKey, signer, digest }
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

`scripts/build-renderer.sh` (run via `npm run build:renderer:frontend`) is the
hook that pulls the frontend in as the renderer source. Use it instead of the
demo `src/renderer/`. The script is the single place that resolves the frontend
checkout, applies the build, and stages the output for `electron-vite` /
`loadFile`. Keep the two source changes above in the frontend branch the script
builds from.

After swapping the renderer, re-run the validation gates from the README
(`format:check`, `lint`, `typecheck`, `test`, `build`) before packaging.
