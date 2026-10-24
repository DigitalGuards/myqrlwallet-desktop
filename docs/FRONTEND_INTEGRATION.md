# Reusing myqrlwallet-frontend as the renderer

The bundled renderer is the `myqrlwallet-frontend` React app, built into
`out/renderer/` by `scripts/build-renderer.sh`. Desktop signing calls
`window.qrlWallet.requestSignature` (`wallet:requestSignature`). Native password
unlock calls `window.unlockBridge.submit` (`unlock:submit`) from the separate
unlock window. Main validates each route and brokers it to the isolated signer.
The wallet renderer also exposes `window.qrlWallet.unlock` (`wallet:unlock`)
as a separate entry point; the normal native password form uses `unlockBridge`.

Once an account exists, the signer holds decrypted keys and performs signing.
During account setup, the renderer shows a new account's recovery phrase once
for backup. Import forms read typed recovery phrases and hex seeds, and encrypted
wallet files are decrypted in the renderer or its worker. Main brokers these
secrets between the renderer and the signer. A compromised renderer during setup
or import can recover that account. This document describes the integration
and its bridge contract.

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
`connect-src` in `src/main/config.ts` (`connectSrcOrigins()`), which restricts
the request types it governs, including fetch, XHR and WebSockets. The policy
also includes `img-src 'self' data: https://<SERVER_HOST>` and
`worker-src 'self'`. The image host is selected from
`VITE_NODE_ENV` and the matching `VITE_SERVER_URL_PRODUCTION` or
`VITE_SERVER_URL_DEVELOPMENT` during both builds; electron-vite freezes it into
main, and `build-renderer.sh` uses it in the meta policy. Production defaults
to `https://qrlwallet.com`. Existing connection-origin configuration still
applies independently.

The [pinned-renderer inventory](RENDERER_CSP_INVENTORY.md) found local images,
inline data images, backend IPFS artwork, local fonts/video and a separate
`cryptoWorker-*.js` file for encrypted extension-wallet imports. It found no
image blob dependency, explorer-host images or executable `ipfs.io` fallback;
that public gateway appears only in frontend privacy copy. NFT and token
artwork hosted elsewhere uses the placeholder. The Add NFT picker shows covers
through the frontend's `NftImage` component since myqrlwallet-frontend #421, so
the desktop builds the web wallet unmodified.

`test/buildRendererScript.test.ts` compares all directives for matching inputs
under production, staging and custom hosts, excluding header-only
`frame-ancestors`. Existing main-only connection additions remain intact.
`X-DNS-Prefetch-Control: off` is delivered by header and meta; the main process
also restricts direct WebRTC UDP. Allowed service URLs, external-browser
links, explicit DNS/preconnect hints and WebRTC TCP/proxy paths remain possible
outbound channels for setup/import secrets. See the
[complete policy and residual review](../SECURITY.md#2-strict-content-security-policy).

## Refactor the in-renderer crypto call sites

These web-wallet call sites use the native bridges on desktop for ordinary
unlock and signing. The frontend's crypto worker and `WalletEncryptionUtil`
remain available for encrypted-wallet-file import, which recovers plaintext
recovery material in the renderer or its worker before main brokers it to the
signer.

| Frontend call site | Today (in renderer) | Desktop: delegate to |
|---|---|---|
| `src/stores/qrlStore.ts` (around the `signTransaction` path, lines ~583/587) | `deriveHexSeedAsync(mnemonic)` then `qrlInstance.accounts.signTransaction(txObject, privateKey)` | `window.qrlWallet.buildTransaction(...)` then `window.qrlWallet.requestSignature({ kind: 'transaction', tx })`, then `window.qrlWallet.sendRawTransaction({ rawTx })` |
| `src/components/Core/Body/DAppConnect/DAppApprovalModal.tsx` | `WalletEncryptionUtil.decryptSeedWithPin(...)` -> `hexSeed`, then `web3.accounts.signTransaction` / `signMessage` / `signTypedData` (lines ~100, ~239) | `window.qrlWallet.requestSignature({ kind: 'transaction' \| 'message' \| 'typedData', ... })` |
| `src/utils/crypto/walletEncryption.ts` (`WalletEncryptionUtil`) | encrypt/decrypt seed under PIN in-page | Desktop PIN storage and ordinary unlock/signing avoid this path. Native password unlock uses `window.unlockBridge.submit(...)`; encrypted-wallet-file import still decrypts in the renderer before `window.qrlWallet.importWallet(...)`. |
| `src/utils/crypto/cryptoWorker.ts` / `cryptoWorkerClient.ts` (`deriveHexSeed` worker) | derives the hex seed from the mnemonic in a web worker | Desktop account derivation happens in the signer (`src/signer/signing.ts`); encrypted-keystore import still uses renderer-side worker decryption. |
| `src/utils/signing/*` (`sign.ts`, `messageDigest.ts`, `typedData.ts`, `ctx.ts`) | computes digests + ML-DSA-87 signatures in-page | the isolated signer computes message and typed-data digests and signatures with canonical fixture parity. |

The signer reproduces the audited path byte-for-byte: it shares the same
`SCHEME` context tags and `MLDSA87` sizes (`src/shared/constants.ts`) and mirrors
`src/utils/signing/sign.ts` + `qrlStore.sendTransaction`, so a desktop-produced
signature verifies identically to a web-wallet one.

## Multi-wallet + import routes (bridge contract v2)

Native storage has no ten-account cap: it stores one encrypted envelope per
address, each under its own password, in `userData/wallet/seeds/<address>.json`.
The renderer blocks imports at ten accounts and requires removing an existing
account before importing another. There is a single ACTIVE account and at most
one unlocked signer session. The bridge surface for the frontend:

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
- Encrypted-wallet-file restore decrypts the file in the renderer or its worker,
  then passes the recovered phrase or hex seed through
  `window.qrlWallet.importWallet` and main to the signer. Typed recovery phrases
  and hex seeds follow the same bridge route. A compromised renderer during
  import can recover that account.

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

Message and typed-data signing first call `assertNetworkReady`, which checks
`qrl_chainId` and genesis over RPC; signing is refused while RPC is unavailable,
including typed data without a domain chain ID. Typed data with a domain chain
ID also waits for a successful RPC lookup to compare it with the wallet chain.
Approval stays disabled while that lookup is pending or failed; a domain
mismatch is shown as a warning. These renderer prerequisites run before the
native signing bridge.

## Adapter sketch: delegate the existing signing service

This illustrative sketch covers signing, import and session-status bridge
calls. The bundled frontend implements its adapter in `src/desktop/bridge.ts`.
Callers perform the network checks above before signing. Native password
collection belongs to the separate unlock window and its `unlockBridge` route.

```ts
// src/adapters/desktopSigner.ts  (in the frontend, desktop build only)
//
// Illustrates signing and import bridge calls. Signing decrypts keys in the
// signer. Setup/import recovery material is handled in the renderer and
// brokered through main, including renderer-side wallet-file decryption.
// Callers apply the renderer's network checks before signing.

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

  // Locking surfaces the separate native unlock window when a wallet exists.
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

On desktop, `qrlStore.ts` and `DAppApprovalModal.tsx` call the desktop signing
adapter after the renderer's network checks. The web PIN-entry UI is hidden.
The native password form calls `window.unlockBridge.submit(password, address)`
in `src/unlock/main.tsx`; `src/unlock/preload.ts` sends `unlock:submit`, handled
by `src/main/unlockWindow.ts`. `window.qrlWallet.unlock` sends `wallet:unlock`
to `src/main/ipc.ts` and remains a separate renderer bridge entry point.
Autolock state reaches the wallet UI through `onLockStateChanged`.

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
