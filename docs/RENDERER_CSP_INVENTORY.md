# Wallet renderer CSP inventory

Reviewed on 2026-10-24 for desktop 1.4.5. The frontend base is CI's detached
`683d0642f2b91b9e70c61e56989bddc4ff4b1ab0`; the desktop baseline is
`14f6bfdc471fb49d07b49483c504183d5f2ba5d3`. The baseline ran the unmodified
frontend. The tightened run added the Add NFT picker change described below,
which now ships in the frontend itself.

The run uses real Electron with Chromium sandboxing enabled, a fresh temporary
profile, an Xvfb server with TCP listening disabled, and synthetic accounts and
explorer responses. DNS resolution for external hosts is disabled during the
run. HTTP requests are intercepted with deterministic responses. The test's OS
browser opener is intercepted too. This is local renderer qualification with
synthetic holdings; it does not establish live gateway availability or testnet
transaction behavior.

The [machine-readable evidence](renderer-csp-inventory.json) records resource
attempts by screen, loaded file resources, inline image observations, workers,
CSP violations and the bounded channel probes. Playwright observes remote
request attempts; instrumentation of the existing file handler observes local
assets; worker events cover the separate crypto-worker load. A blocked request
can appear in the attempted-request list. The tightened run separately checks
that the intercepted image responder receives only backend image URLs.

## Screens and flows exercised

Home with an empty profile and with an account; account creation through the
backup screen; accounts; token discovery and imported token rows; NFT discovery,
collection list, gallery and detail views; transfer; history; contacts; dApps;
renderer settings; address QR display and copying; mnemonic import, hex-seed
import and encrypted extension-wallet file import through account provisioning.
The public extension-keystore test vector uses Argon2id and AES-GCM and reaches
the real bundled crypto worker. Four accounts persist in the isolated profile
after creation and the three import paths. Profile contents are removed after
the run, and recovery material is excluded from the evidence.

The synthetic explorer metadata contains an `ipfs://` artwork URL and an
unrelated `https://art.example/nft.svg` URL in separate NFT collections. These
exercise the raw metadata path in `discoverNFTs`, including actual CSP failure
handling. Direct tokenURI metadata ingestion additionally sanitizes raw HTTPS
images in `fetchNftMetadata`; that source-level behavior is recorded below.

## Resource inventory and producers

All frontend paths in this table refer to the pinned revision. `bundle:/`
denotes the local renderer directory after the desktop file handler remaps
root-absolute frontend paths. Hashes shown here are the emitted asset names.

| Resource | Runtime result and source producer |
|---|---|
| `bundle:/tree.svg` | Local image/preload. `src/components/Core/Layout/Layout.tsx:11`, `src/components/Core/Body/Home/BackgroundVideo/BackgroundVideo.tsx:7`, `index.html:117`. |
| `bundle:/icons/theqrlwallet/192.png` | Local image preload from `index.html:118`. The favicon, alternate PNG sizes, touch icon and manifest icons also use bundled paths in `index.html:5-31` and `public/manifest.webmanifest`; they add no remote origin. |
| `data:image/svg+xml,...` | Body grain background from `src/index.css:217`, present in computed styles on each screen. QR copying successfully loads an SVG data URL created by `src/components/Core/Body/AccountList/CopyAddressButton/CopyAddressButton.tsx:63-80`, then draws it to a canvas and writes a PNG to the clipboard. |
| QR codes, wallet mark and UI icons | Inline SVG with no image request. Producers include `ReceivePopup.tsx`, `ActiveAccount.tsx`, `CopyAddressButton.tsx`, `MnemonicDisplay.tsx`, `QRView.tsx`, `MyQRLWalletLogo/QrlMark.tsx` and Lucide components. |
| `https://qrlwallet.com/api/ipfs/bafybeicspfixture/art.svg` | Loaded in NFT picker, collection, gallery and detail views. `src/utils/web3/nft.ts:39` defines `IPFS_GATEWAY = SERVER_URL + '/ipfs/'`; `resolveIpfsUri` at line 321 resolves both `ipfs://CID` and `ipfs://ipfs/CID`. `NftImage.tsx:23` calls it before rendering. |
| `https://art.example/nft.svg` | Synthetic plain HTTPS NFT metadata. `src/utils/web3/nftDiscovery.ts:75` preserves explorer-provided `image`; the baseline loads it, the tightened CSP blocks it. `NftImage.tsx:73` moves to its terminal error state and `Fallback` at line 84 renders the existing icon. |
| Direct tokenURI images | `src/utils/web3/nft.ts:373-390` accepts proxied IPFS and inline `data:image/` values and drops raw HTTP(S) image fields. Cached/explorer metadata can still carry raw URLs, so CSP enforcement remains necessary. |
| Public IPFS fallback | No executable fallback and no request to `ipfs.io` in this pin. The only source occurrence is privacy copy in `src/components/Core/Body/Privacy/Privacy.tsx:119`. The gateway resolver and image error handler contain no retry to that host. It is excluded from `img-src`. |
| Explorer images, token logos and avatars | No fixed explorer image URL or avatar loader found. The explorer supplies JSON. `TokenInterface` in `src/constants/tokens.ts` has no logo field; `tokenDiscovery.ts` copies name/symbol/address/amount/decimals, and token cells render text. A supplied synthetic logo URL produces no image request. Contacts and dApp sessions render text and inline icons. Arbitrary image URLs supplied through NFT metadata receive the same CSP checks. |
| Browser-extension icons | `ExtensionPickerDialog.tsx:47` renders `detail.info.icon` in web mode. Its connection controls are hidden on desktop by `AccountCreateImport.tsx:184`; this flow produced no image requests. |
| `bundle:/qrl-video-dark.mp4` | Local muted decorative video from `src/components/Core/Body/Home/DecorativeAccountVideo.tsx:173`. No remote media request or media blob was needed. Existing `media-src 'self' blob:` remains unchanged. |
| Four local WOFF2 font files | `instrument-sans-latin-wght-normal-BbzFLZTg.woff2`, `inter-latin-wght-normal-Dx4kXJAl.woff2`, `jetbrains-mono-latin-wght-normal-B9CIFXIH.woff2`, `sora-latin-wght-normal-DdqRvwsR.woff2`, emitted under `assets/`. `src/main.tsx:40-43` imports the four Fontsource stylesheets. Other language subsets are bundled by those same imports. |
| `bundle:/assets/cryptoWorker-B-s8DXu7.js` | Loaded during encrypted extension-wallet import. `src/utils/crypto/cryptoWorkerClient.ts:38` imports `./cryptoWorker?worker`; `decryptKeystoreAsync` at line 310 uses it. The import completes under `worker-src 'self'`. |
| Blob resources | No image blob or blob worker is required by the desktop flows. `walletEncryption.ts:499` creates a download object URL; it is an export action. The `?worker&inline` rewrite belongs to `config/vite.config.embedded.ts` and `src/config/embeddedBuild.ts`, which are separate mobile build inputs. A generated blob worker probe runs under the baseline and is blocked under the tightened policy. |

## Policy and placeholder checks

| Directive | Baseline | Tightened |
|---|---|---|
| `img-src` | `'self' data: https:` | `'self' data: https://<SERVER_HOST>`; production host is `qrlwallet.com` |
| `worker-src` | `'self' blob:` | `'self'` |

Every other directive retains its value. The backend image origin is selected
from the same production/staging build inputs for the main bundle and renderer
meta policy. Header/meta tests compare all directives with matching connection
inputs. Existing RPC failover/HMR connection additions remain main-owned;
`frame-ancestors` remains header-only.

The original Add NFT picker has a bare `<img>` at
`src/components/Core/Body/Nfts/AddNftModal.tsx:379`. It neither resolves raw IPFS
URIs nor renders the image-error placeholder. The inventory run switched that
element to the existing `NftImage` component; myqrlwallet-frontend #421 makes
the same change in the frontend, and desktop 1.4.5 pins a frontend revision that
includes it, so the desktop builds the web wallet unmodified.

The tightened picker displays the HTTPS NFT placeholder in a 40 by 40 pixel
box and loads the IPFS image next to it. The detail placeholder is 327 by 327
pixels in the default 1100 by 800 window, matching the loaded IPFS artwork's
box. It remains intact in an 800 by 700 window with no horizontal overflow.
Screenshots were visually inspected. Each failed mount emits a finite set of
Chromium CSP diagnostics from the enforced header/meta policies. A settled
detail view generates zero additional requests or console errors over the
2.5-second observation interval. The existing component keeps its terminal
error state until its source changes or it remounts.

## Residual-channel verification

The full channel assessment is in
[SECURITY.md](../SECURITY.md#remaining-outbound-channels).

- An unrelated CSS background-image URL is blocked by `img-src`. Allowed
  service origins can still receive encoded values through paths, queries or
  request bodies. Existing fetch/XHR/WebSocket/beacon restrictions remain.
- Header and meta disable automatic DNS prefetch. Explicit DNS/preconnect hints
  retain separate implementation paths. Chromium's
  [document DNS policy](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/core/dom/document.cc)
  and [explicit link handling](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/core/loader/preload_helper.cc)
  explain the distinction. These hint paths remain documented residual risks;
  this run makes no packet-level claim about them.
- A local STUN receiver records four packets under the baseline WebRTC policy
  and zero with `disable_non_proxied_udp`. No media permission is requested by
  the data-channel probe. Electron's
  [IP-handling API](https://www.electronjs.org/docs/latest/api/web-contents#contentssetwebrtciphandlingpolicypolicy)
  leaves TCP and proxy-mediated communication available.
- Unrelated navigation and `window.open` attempts are blocked. An allowed
  `github.com` URL with a synthetic query reaches the intercepted OS opener,
  showing that the existing allowlist still permits that outbound path.
  Redirect and webview handlers remain in place. Geolocation permission is
  denied; the existing permission-handler unit tests cover media/device denial
  and the clipboard-write exception.
- Generated blob-worker execution is blocked. The bundled crypto worker still
  imports the encrypted wallet successfully. This restricts worker code sources;
  it supplies no general guarantee for compromised renderer code or allowed
  services.

## Reproduction

Use the CI-pinned detached frontend worktree and installed dependencies. The
inventory script uses Playwright from that frontend's locked dependencies.
Set `QRL_CSP_EVIDENCE` to an output directory to retain JSON and screenshots.
The default is a fresh temporary evidence directory. No real display is used.

```bash
QRL_FRONTEND_DIR="$FRONTEND_WORKTREE" npm run build
env -u DISPLAY -u WAYLAND_DISPLAY QRL_FRONTEND_DIR="$FRONTEND_WORKTREE" \
  xvfb-run -a -s '-screen 0 1280x900x24 -nolisten tcp' \
  node scripts/csp-inventory.mjs
```

`QRL_CSP_EXPECT_TIGHT=0` selects baseline expectations when running an old
desktop build. Remove the detached frontend worktree after validation. The
inventory is supplementary to the repository's audit, format, lint, ratchet,
typecheck, unit-test, build and confirmation-inventory gates.
