# Changelog

All notable changes to the MyQRLWallet desktop app are documented here.

## Unreleased

### Security

- Serve the wallet, unlock and settings windows from a privileged `app`
  scheme, one origin per window, as Electron's security checklist recommends.
  The app denies `file://` requests and turns off the
  `GrantFileProtocolExtraPrivileges` fuse. Native window IPC accepts only each
  window's own main document.
- Move the wallet's stored preferences to the new origin once, before the
  wallet opens: every stored entry is copied, entries already present are
  kept, and the old copy stays in place. If the move fails, the app still opens
  and tries again on the next start.
- Add a personal phrase to the native unlock window, with native Settings
  controls to view, regenerate or customize it in all five supported languages.
  Main generates and saves the phrase while preserving existing preferences.
  The wallet renderer has no access to it. Checking the phrase helps users
  recognize fake password prompts drawn by a compromised wallet window.
  Malware that can read the settings file or the screen can copy the phrase.

## 1.4.5 - 2026-10-24

### Added

- The wallet's Settings page has a language choice: English, German, Spanish,
  Russian or Simplified Chinese. The choice also updates the unlock window,
  desktop settings, menus and wallet-owned notices, and stays across restarts.
  Desktop 1.4.4 followed the system language. `Open desktop security settings`
  on the same page opens the auto-lock and biometric quick unlock settings.

### Fixed

- The Add NFT picker shows collection covers through the wallet's NFT image
  component: `ipfs://` covers load through the backend gateway, and covers that
  cannot load show the placeholder.

### Security

- Restrict wallet-window images to bundled/data sources and the configured
  backend/IPFS gateway; block generated blob workers while retaining the
  bundled encrypted-import worker. External NFT and token artwork uses the
  placeholder, the Add NFT picker included.
- Disable automatic DNS prefetch and restrict direct WebRTC UDP. Document
  allowed-service, external-browser, explicit resource-hint and WebRTC TCP/proxy
  channels that remain available to compromised renderer code. Add header/meta
  policy parity tests and a reproducible Xvfb request inventory.
- Retain Electron 44.9.3 with Chromium 152.0.7977.167 and Node 24.22.0. As of
  2026-10-24, no stable Electron release bundles Node 24.22.1, including 45.0.0.

### Release scope

- Bundle frontend main revision
  `1ee1fc499c13af462d59e60eacde7ca8ec43ebd0`, the web wallet released on
  2026-10-24 with the desktop language choice and the Add NFT picker fix, built
  by `scripts/build-renderer.sh`. CI uses the same pinned source revision.

<!-- discord -->
**MyQRLWallet Desktop 1.4.5** adds a language choice to Settings: English, German, Spanish, Russian or Simplified Chinese for the wallet and the desktop windows. The wallet window now loads images only from the app and the wallet backend, and runs only its own bundled background workers, which narrows what a compromised page could reach. The Add NFT picker shows collection covers, with a placeholder for covers that cannot load. Electron stays at 44.9.3; a further stable runtime update is still needed for the October Node.js security fixes.
<!-- /discord -->

## 1.4.4 - 2026-10-24

### Added

- Desktop unlock and settings windows, custom menus and wallet-owned notices
  support English, German, Spanish, Russian and Simplified Chinese. The bundled
  wallet supports the same five languages, and its language choice updates the
  desktop surfaces. Platform menu roles retain their OS-provided localization.
- Trusted transaction, message, typed-data and Remove wallet confirmations stay
  English for now.

### Fixed

- Long transaction confirmations split into pages sized for the display's work
  area. Every page repeats the `Send {amount}?` and `Max cost {max cost}.`
  heading, the request number and page indicator, and the approval reminder.
  The body continues through the original detail rows in order: amount,
  recipient, sender, nonce, gas limit and its provenance or warnings, maximum
  fee, maximum cost, chain ID, data preview, and any unverified dApp origin.
  Each original detail line appears once across the pages; the origin block
  ends on the final page. A row that exceeds a whole page continues under its
  label with ` (continued)`. Long headings wrap while retaining every digit.
- Earlier transaction pages offer `Next` and `Cancel`; only the final page
  offers `Approve & sign`. Cancel stays the default and Escape action on every
  page. Short transactions within the page allowance retain their existing
  single-page rendering. Transactions have no page cap; message and typed-data
  review limits stay unchanged.
- Transaction page visibility is qualified on Linux GTK 3 at 1024x768 and
  1280x720, with DejaVu Sans 8 to 12 pt at 100% and 125% text scaling. Other
  platform, font and display combinations can still overflow. Moving the
  wallet to another display or changing display metrics aborts the review so
  it can restart with the current layout.
- The wallet's dApp approval controls enable only after every review detail
  has been shown in the visible area. Changes to the request or its review
  details require those details to be shown again.

### Security

- Update the locked zod dependency to 4.6.7 and move `@theqrl/web3-validator`
  onto the same version through a scoped override. Keep the desktop's existing
  UTF-16 input caps, including passwords, recovery phrases and dApp metadata.
  Strict requests with an own `__proto__` key are rejected. The bundled
  frontend includes its corresponding zod fix.
- Include the renderer's typed-data chain check: a request with a domain chain
  ID waits for a successful wallet chain lookup before approval.
- Retain Electron 44.9.3 with Chromium 152.0.7977.167 and Node 24.22.0.
  As of 2026-10-24, [stable Electron releases](https://releases.electronjs.org/)
  do not yet bundle Node 24.22.1; alpha and nightly builds do. A further stable
  runtime update remains necessary for the October Node.js security fixes
  described in the [1.4.3 security notes](#143---2026-10-22).
- Correct the security documentation. The renderer handles recovery material
  during account setup and import; message and typed-data signing need RPC;
  the CSP allows HTTPS images to any host and blob workers, so a compromised
  renderer can send out secrets it reads; whoever recovers the keychain KEK can
  decrypt the wallet without the password; Linux does not enforce embedded ASAR
  integrity; and a compromised renderer can draw a lookalike unlock prompt.
  Earlier documents and release notes overstated these protections. No code
  change.

### Release scope

- Bundle frontend main revision
  `683d0642f2b91b9e70c61e56989bddc4ff4b1ab0`, the web wallet released on
  2026-10-24, built by `scripts/build-renderer.sh`. CI uses the same pinned
  source revision.

<!-- discord -->
**MyQRLWallet Desktop 1.4.4** brings English, German, Spanish, Russian and Simplified Chinese to the wallet, desktop windows and menus. Long transaction confirmations split into pages, repeating the amount and maximum cost on each page. Wallet dApp approvals enable after every review detail has been shown. Trusted transaction and signing confirmations stay English for now. This release also includes dependency fixes and the wallet's typed-data chain check. Electron stays at 44.9.3; a further stable runtime update is needed for the October Node.js security fixes.
<!-- /discord -->

## 1.4.3 - 2026-10-22

### Security

- Upgrade Electron from 44.7.2 to exactly 44.9.3 in the lockfile, preserving
  the manifest's caret range. It bundles Chromium 152.0.7977.167 and Node 24.22.0.
- Include the [eMudhra certificate mitigation introduced in Electron 44.9.1](https://github.com/electron/electron/releases/tag/v44.9.1).
  The [Electron advisory](https://github.com/electron/electron/security/advisories/GHSA-jr5w-w6x2-84p9)
  confirms that both Chromium and Node networking block the compromised
  intermediates, protecting connections against server impersonation.
- Include the [44.9.3 backports from ANGLE, Chromium, PDFium, Skia and V8](https://github.com/electron/electron/releases/tag/v44.9.3).
- Coverage of the [October Node.js security release](https://nodejs.org/en/blog/release/v24.22.1)
  is incomplete: Electron 44.9.3 bundles Node 24.22.0 with selected patches.
  Local runtime checks using upstream TLS regression cases still accept
  non-canonical and fullwidth IP hostnames against DNS certificate names.
  Node 24.22.1 fixes these hostname bypasses, the Brotli decoder RCE
  (CVE-2026-111497), DNS name truncation and other issues. A further runtime
  update is required to satisfy the full October Node.js security-update scope.

### Release scope

- Retain the 1.4.2 renderer from frontend dev revision
  `c63534ab08620897280f26f3bd3927f5102331b2`, built by `scripts/build-renderer.sh`.
  CI uses the same pinned source revision.
- Preserve all nine explicit fuses, `strictlyRequireAllFuses`, CSP, permission
  handlers, sandbox, context isolation, signer utility process and navigation
  restrictions. Wallet behavior is unchanged.

<!-- discord -->
**MyQRLWallet Desktop 1.4.3** is a security update. Electron 44.9.3 blocks compromised eMudhra certificates that could let an attacker impersonate a server and includes additional browser-engine security fixes. The wallet screens and security settings stay the same. Updating is recommended for these protections. A further runtime update is needed for the separate October Node.js security fixes.
<!-- /discord -->

## 1.4.2 - 2026-10-17

### Security

- Upgrade Electron to 44.7.2, which carries 28 Chromium security backports.
- The renderer is rebuilt from the current web wallet, which now passes the
  full strict type-aware lint rule set with no exceptions, and includes its
  fee labelling, testnet value and error-message fixes.

### Changed

- Strict type-aware lint for the desktop sources and tests, with a ratchet that
  CI only lets shrink. The ratchet is empty: every finding was fixed.
- CI runs the quality gates on every pull request and rejects lint findings
  hidden by bulk-suppression files or by a `@ts-nocheck` directive in any
  letter case.

## 1.4.1 - 2026-10-13

### Changed

- Upgrade Electron to 44.7.0 (Chromium 152, Node 24.18.1) and target Chromium 152
  for the native unlock and settings renderers. Keep the Node 22 type floor.
- Require macOS 13 or later for macOS packages. Electron 44 supports 64-bit
  platforms; the existing Windows and Linux release targets remain compatible.

### Security

- Main wraps every trusted confirmation detail line at 48 display columns with
  a conservative glyph-width model calibrated against the default GTK sans
  font (DejaVu Sans). ASCII advances above 0.8 em and `OQGDHNU&` count as two
  columns, including lowercase `m` and `w`. Non-ASCII advances above 1.27 em
  and every code point above U+FFFF count as three columns, including native
  six-digit hex fallback boxes when a usable font is missing.
  Known ultra-wide glyphs in U+2E3A-U+2E3B, U+FDFA-U+FDFD and U+12000-U+1254F
  use atomic, reversible `\u{...}` escapes.
- Every main-wrapped line carrying dApp or renderer text starts with a
  main-written U+200E LEFT-TO-RIGHT MARK followed by its label or gutter, keeping
  Hebrew and Arabic paragraphs' markers on the left. Supplied U+200E remains
  escaped. Message bodies use a `| ` gutter; metadata, typed data, transaction
  recipients and transaction data continue with `    | `.
  Trusted notes, labels, verified signer and wallet-removal accounts,
  wallet-renderer provenance and main-formatted numeric values continue with
  a plain four-space indent, breaking at word boundaries where possible.
  The pipe identifies dApp-supplied text on main-wrapped continuations and
  message body rows.
- Residual risk: rows made of unusually wide glyphs can still wrap in some
  fonts. The wrapped overflow then shows without a main-written marker and
  can resemble dialog chrome. The native bold page label and approval flow
  are unaffected.
- Multi-page reviews show their page indicator beside the request number in
  the native bold label. Message and typed-data reviews retain the 30-line and
  10-page limits, counting every wrapped detail line before opening a dialog.
- Set all nine Electron 44 fuses explicitly and fail packaging on unreviewed
  fuses. Preserve the existing `file://` privileges and WebAssembly trap handlers.
- Exclude local frontend source archives from packaged application files.
- Document the Electron 43/44 compatibility review, including clipboard
  permissions, signer isolation and native confirmation cancellation.

### Fixed

- Typed-data section headings stay with their first complete field row when
  paginating, preserving the 30-line budget and 10-page limit.
- Transaction confirmations put the max cost on its own line of the bold
  label (`Send 1 Quanta?` then `Max cost ... Quanta.`), so the toolkit no longer
  wraps it for amounts up to ten whole digits; the 80-digit schema maximum
  still wraps.
- Message reviews keep JSON quotes literal while escaping backslashes and
  invisible characters, preserving the exact signed bytes. Typed-data previews
  and continuations preserve complete escapes and Unicode code points.

## 1.4.0 - 2026-10-12

### Added

- Desktop dApp typed-data signing using QRL-SIGN-TYPED v1/v2 in the isolated
  signer, with canonical wallet/SDK digest and deterministic signature parity.
- Trusted typed-data confirmation showing scheme, domain, nested message fields,
  address groups, explicit display limits and domain-chain mismatch warnings.
- Shared bounded validation at the main and signer boundaries, plus account and
  scheme binding on signer responses.

### Security

- Trusted confirmations page through long requests: every field appears once,
  Approve is offered only on the last page, and requests over 10 pages are
  refused.
- One confirmation at a time. A second request while one is open fails with
  "another confirmation is already open", and no dialog page opens sooner than
  1 second after the request arrived or the previous page closed, so a
  double-click cannot approve a request the user has not seen.
- Every confirmation page carries a request number assigned by the app.
- Lock, autolock, a signer exit, and a wallet window reload or crash close an
  open confirmation and reject it.
- Message signatures get the same complete review: the trusted dialog shows
  every byte of the message across pages, as text with control and invisible
  characters escaped or as full hex, and every message row starts with a `| `
  gutter so message text cannot imitate the dialog's own lines. Before, it
  showed only the first 128 bytes.
- Electron 42.11.12, with the upstream fixes for popups and windows from
  sandboxed documents, cross-origin reads through protocol handlers and
  preload code cache poisoning by a compromised renderer.

### Changed

- Renderer refresh from the current web wallet: the send screen shows each step
  (waiting for approval, signed and sent, confirmed, failed or rejected), new
  transactions appear in History as pending straight away, every page shares
  one layout, dApp approval dialogs fit the window with their buttons always
  visible, and typed-data reviews warn when the request names another chain.
- A dApp request with a crafted typed-data type can no longer freeze the wallet
  window while it is validated.

### Fixed

- Offline dApp message signing passes the configured network ID through the
  private signer protocol, satisfying its positive-chain-ID guard.

### Internal

- Hardened TypeScript is enforced in CI, with runtime checks on every message
  between the main process and the signer.
- Groundwork for Ledger hardware wallets: an APDU client for the QRL Ledger
  app, not yet enabled in the app.
- Published releases are announced on Discord.

## 1.3.1 - 2026-09-28

### Changed

- Transaction fees follow the node's fee market, the same policy as the web
  wallet's send screen. The priority tip is the node's suggestion
  (`qrl_maxPriorityFeePerGas`) scaled by fee level (1x low, 1.5x medium, 2x
  high), and the fee cap is twice the latest base fee plus that tip, so a
  transaction stays includable while the base fee rises. Previously the tip was
  about 1 gwei against the node's 2.5 gwei suggestion. Only the base fee plus
  the tip is charged; the rest of the cap is refunded. The old `qrl_gasPrice`
  tiers remain as the fallback for a node without the method, and a fallback is
  now logged.
- Renderer refresh from the web wallet: dApp approvals on the web and mobile
  paths use the same fee-market pricing.

## 1.3.0 - 2026-09-28

### Added

- A dApp connected over `@qrlwallet/connect` can now ask for a gas limit, which
  the web and mobile wallets already honoured. The builder uses the larger of
  the request and its own `qrl_estimateGas` result with the usual 1.2x buffer,
  so a request below the estimate cannot produce an out-of-gas transaction and a
  larger one is used exactly as asked. This unblocks QuantaSwap HTLCv3
  settlement, which needs `estimateGas + 250000` because a claim, refund or
  release that runs out of gas defers the payout into a credit. A request above
  the latest block's gas limit is refused, and the same ceiling is re-checked
  when a transaction reaches the signing path.

### Changed

- The trusted confirmation window now says where a transaction's gas limit came
  from: the wallet's own estimate, the dApp with the wallet's estimate shown
  alongside it, or the block gas limit when that capped the result. It warns
  when a dApp asks for far more gas than the wallet estimated, prices the worst
  case as gas limit times the fee cap, and repeats the max cost in its headline,
  because for a zero-value contract call the fee is the whole cost. When the
  wallet has no record of building the transaction it says so plainly, and
  flags a limit claiming more than a tenth of a whole block.
- The gas limit on a transaction handed to the signer must now be a canonical
  positive decimal, so a single number has exactly one spelling everywhere it is
  displayed and signed.
- The signer and the wallet use the hardened 2026-09 releases of the QRL crypto
  libraries (ML-DSA-87 2.2.0, wallet.js 6.3.0).
- Renderer refresh from the web wallet: the hardened crypto libraries, explorer
  links and transaction history on zondscan.com only, layout fixes for narrow
  windows, and the dApp gas limit forwarded to the desktop signer.

## 1.2.1 - 2026-09-25

### Fixed

- The full address on the Account List no longer draws over itself. The
  revealed address now lays its 16 groups out in 2, 4 or 8 columns to fit
  the card, and the account card moves its buttons below the address while
  it is revealed. Renderer refresh from the web wallet; no change to the
  desktop shell.

## 1.2.0 - 2026-09-25

### Changed

- Settings now opens inside the wallet window as an embedded panel over the
  wallet view, so the app keeps one window, one title and one taskbar entry,
  and stays resizable. The panel is still a separate, main-owned web contents
  with its own preload, its own no-network CSP and the same sender-gated IPC,
  so the renderer still cannot read or write any desktop setting; it can only
  ask for the panel to be shown. Its header carries a Back control, Escape
  closes it, and keyboard focus moves into the panel on open and back to the
  wallet on close. Every previous guarantee holds: the panel refuses to open
  while the lock screen is up, a lock takeover destroys it, and an incoming
  qrlconnect:// link or a dApp attention request closes it so the approval UI
  is never hidden behind it.
- Adopted the new MyQRLWallet 3A brand mark across the shell. New app icons
  (`build/icon.png` 1024, `build/icon.ico` at 16/24/32/48/64/128/256, and the
  `build/icons/` set for Linux), branded NSIS installer and uninstaller
  graphics, and the mark in the native unlock and settings windows. The
  16/24/32 icon entries are pixel-snapped renders: at those sizes the brand's
  inter-block gap falls below one device pixel and a plain vector downscale
  blurs.
- The native unlock and settings windows now use the QRL Blue palette so they
  match the current renderer. Colour tokens only: layout, the window CSPs, the
  preload surfaces, and the trusted main-drawn confirmations are unchanged.
- The native windows now use the brand typefaces, self-hosted and bundled as
  local woff2 (Sora for the wordmark and titles, Instrument Sans for body copy,
  JetBrains Mono for addresses), matching the renderer. No remote font load:
  `font-src` is now explicit at `'self'` in both window policies, and renderer
  asset inlining is off so no font is emitted as a blocked `data:` URL.
- Linux windows now set the app icon explicitly, so an AppImage run without an
  installed desktop entry shows the brand mark instead of a generic icon.

### Fixed

- Token and NFT discovery points at zondscan.com, and the renderer default is
  pinned to the main-process connect-src so the two cannot drift apart.
- The v3 storage notice at boot shows only when legacy wallet data exists, so
  a clean install starts without it.
- The unlock window is trimmed to the essentials: no subtitle, no account chip
  for a single wallet (the picker stays when several wallets exist), and form
  controls use the brand font.

## 1.1.0 - 2026-09-21

### Security

- Message-signing responses now include the wallet's three-byte ML-DSA
  descriptor. Bound SDK verifiers can combine it with the returned public key
  and confirm that the signature belongs to the claimed current `Q` + 40-hex
  address. The roadmap 64-byte address format remains intentionally disabled.
- The QRL web3 signer dependency is now pinned to the current-address-compatible
  1.0.1 release. Version 1.0.3 requires the roadmap 64-byte address shape and
  rejects deployed `Q` + 40 accounts.
- Unlock now derives the address from the authenticated seed and rejects any
  envelope whose public address metadata names a different account. Failed
  unlock paths also wipe their unretained derived KEK.
- Main strictly parses signer-process signing responses, including fixed cryptographic
  widths, exact result arms, transaction alias equality, and request-account
  binding, before returning a result across the renderer bridge.
- Renderer builds now fail when the frontend source, lockfile, or staged entry
  point is missing, always install frontend dependencies with `npm ci`, and
  enforce the desktop meta CSP across multiline or absent frontend meta tags.
- Linux packaging now resolves electron-builder's actual executable name before
  flipping fuses. A missing binary aborts packaging so ASAR integrity and the
  remaining production fuses cannot be silently skipped.

## 1.0.0

Major testnet release. The desktop wallet has carried the full four-process
hardened architecture (isolated signer, trusted main-drawn confirmations,
strict `script-src 'self'` CSP, fuses + ASAR integrity) since the 0.3.x line;
1.0.0 marks it as the stable QRL testnet build rather than a preview, and
refreshes the bundled renderer.

Still a testnet build: it targets the QRL testnet through qrlwallet.com. Do
not treat balances or transactions as mainnet value.

Note on the renderer snapshot: this build bundles the web wallet from its
integration branch, so the wallet-file import/export below reaches desktop
users slightly ahead of the same feature going live on qrlwallet.com.
Everything else in the renderer matches what the web wallet serves today.

### Added

- Wallet-file interop in the bundled renderer: import an encrypted keystore
  backup exported by the MyQRLWallet browser extension, and a PIN-gated
  wallet-file export from Settings.
- MIT `LICENSE` file at the repository root.

### Security

- Renderer CSP `script-src` now carries `'wasm-unsafe-eval'` in both delivery
  paths (the response header from the file-protocol handler and the meta tag
  rewritten by `scripts/build-renderer.sh`). This permits WebAssembly
  compilation ONLY, not JS `eval`: the keystore import above uses hash-wasm
  argon2id, which without it silently falls back to pure-JS argon2id at roughly
  20 seconds per attempt, including every wrong-password retry. `script-src`
  still carries no `'unsafe-inline'` and no `'unsafe-eval'`, and the wasm bytes
  come from the same bundled same-origin scripts the policy already trusts, so
  this does not widen where code can come from. `SECURITY.md`, `THREAT_MODEL.md`,
  `README.md`, and `docs/FRONTEND_INTEGRATION.md` were updated to state the
  shipped policy accurately.

### Changed

- Bundled renderer rebuilt from the current web wallet, picking up
  everything shipped since the 0.3.5 renderer snapshot:
  - Champagne identity color: the blue identity accent is replaced by the
    Obsidian & Ember champagne token, with self-fitting one-line address
    rendering.
  - Native amounts are labelled "Quanta" (not "QRL"), with the unit on a
    secondary line under the balance, and the balance number centered
    independently of the action icons.
  - Compact grouped-list settings page, PIN rows that auto-advance focus, and
    the accompanying accessibility and auto-save hardening.
  - Address book, mobile-device pairing as a remote signer, NFT metadata
    refresh/retry, the EU-compliant legal document set, and the
    recent-transactions popup readability fix.
- Trusted confirmation dialog: amount unit casing corrected from "QUANTA" to
  "Quanta", matching the renderer.

### Notes on 0.3.4 and 0.3.5

Those two releases shipped without changelog entries. For the record:

- **0.3.5** retokened the native unlock and settings windows to the Obsidian &
  Ember palette and refreshed the bundled renderer to match.
- **0.3.4** refreshed the bundled renderer with the address book and
  dApp-connect hardening.

## 0.3.3

First production release: the app now targets prod (qrlwallet.com) by
default, both the bundled renderer and the main process (RPC proxy, CSP
allowlist). Staging builds remain possible by exporting the dev env vars
(scripts/build-renderer.sh + QRL_* runtime env).

### Changed

- Renderer build and main-process defaults flipped from the dev staging
  environment to production; dev failover proxy retained as the secondary
  RPC endpoint.

## 0.3.2

Still a staging build: the bundled renderer targets the dev environment
(dev.qrlwallet.com) by default.

### Changed

- dApp connections page redesigned to match the wallet: card layout with a
  gradient header, status pills, per-session account and date rows, a proper
  empty state, and hover-destructive disconnect. Reached from the sidebar
  dApps item.

### Fixed

- The consent dialog now refuses to pair when the wallet has no account,
  with an inline prompt to create or import one first, instead of leaving a
  ghost "Account: None" session.

## 0.3.1

Still a staging build: the bundled renderer targets the dev environment
(dev.qrlwallet.com) by default.

### Fixed

- dApp contract calls are no longer starved by a fixed 90,000 gas limit:
  transactions carrying calldata are estimated via `qrl_estimateGas` with the
  web wallet's 1.2x buffer, and an estimate that would revert is refused
  before signing instead of burning the fee on a guaranteed on-chain revert
  (first hit by QuantaSwap HTLC locks, which write ~7 storage slots and need
  ~175k gas). Calldata is canonicalized to the `0x` form and the estimate runs
  in parallel with the nonce/gas-price/chain-id reads.

### Changed

- Bundled renderer refreshed: dApp transactions now show the full progress
  ladder on desktop (signing, broadcasting, awaiting confirmation, confirmed),
  answering the dApp only once the on-chain receipt lands (web parity),
  instead of reporting success at broadcast time. Also fixes a progress-state
  leak when a dApp session disconnects mid-transaction.

## 0.3.0

Still a staging build: the bundled renderer targets the dev environment
(dev.qrlwallet.com) by default.

### Added

- Native, main-owned settings window: the single settings surface on desktop
  (the renderer's settings page is bypassed entirely). Full-bleed takeover of
  the wallet window, with an explicit "Back to wallet" button and Esc to close.
  Covers autolock timing, biometric/keychain unlock preference, and per-account
  removal, all handled in trusted native UI behind the same main-drawn
  confirmation as before.
- Main-owned settings store (`settings.json`, atomic 0600 writes, self-healing
  reads). Autolock changes re-arm the running signer session live.
- dApp-connect shell support: `qrlconnect://` deep links (protocol handler,
  cold-start buffering, and second-instance handoff), attention/focus IPC for
  approval UX, and the requesting dApp origin displayed in the trusted
  signature confirmation.
- Main-process file log with dApp-ingress log points for diagnosing pairing
  issues.

### Changed

- RPC now flows through the wallet backend's proxies instead of a raw node
  URL. Reads fail over to a secondary endpoint; a transaction broadcast fails
  over on transport failures only (a node's JSON-RPC rejection always
  surfaces), and a duplicate-known rejection after a retry resolves to the
  signer-computed transaction hash instead of a false failure.

### Security

- Every signature request is bound to the unlocked session's account: a
  request targeting any other account is refused by the signer
  ("signing account mismatch").
- A `qrlconnect://` launch can no longer reveal a locked wallet window, and
  dApp attention requests are ignored while the unlock screen is up.
- Signature results carry an explicit `schemeVersion`.

### Fixed

- Startup errors fail loudly with a native dialog instead of a silent zombie
  process.
- Windows cross-builds ship the win32 argon2 NAPI bindings (0.2.x Windows
  installs could hit a signer that died at boot).
- NSIS shortcut metadata kept under the 260-char `.lnk` limit (0.2.x could
  corrupt the shortcut icon/working-directory fields).

## 0.2.1

### Added

- App icon (the MyQRLWallet brand mark) baked into the installer, the executable,
  and the created shortcuts. Earlier builds used the default Electron icon.
  `build/icon.png` (1024) + a multi-size `build/icon.ico` (16-256), wired via
  explicit `mac`/`win`/`linux` icon keys.

## 0.2.0

First public release of the hardened desktop wallet. Staging build: the bundled
renderer targets the dev environment (dev.qrlwallet.com).

### Added

- Multi-wallet support: any number of accounts on one device, each encrypted
  under its own password (one envelope per address). Add accounts without
  removing the previous one; switch the active account from the wallet list.
- Import from a mnemonic OR a raw 51-byte hex extended seed. Both encode the
  same key, so the signer regenerates the canonical mnemonic and stores an
  identical envelope either way. Encrypted-wallet-file restore is also wired.
- Native unlock window with an account picker when more than one wallet exists;
  each wallet unlocks with its own password.
- Per-account removal from Settings ("Remove Account"), gated by a trusted
  main-drawn confirmation that names the address; other accounts are untouched.

### Security

- Strict Content-Security-Policy (`script-src 'self'`, no inline/eval) is now
  delivered as a real response header on every `file://` response by the
  file-protocol handler, not just the meta tag, and the built renderer's meta
  CSP is rewritten to match.
- The `file://` handler is contained to the app bundle: arbitrary host-file
  reads (e.g. `/etc/passwd`) are refused with 403.
- Chain id is never guessed: an unreachable node fails signing loudly rather
  than binding a transaction to a fallback chain, and the value confirmed in
  the trusted dialog is exactly the value signed.

### Fixed

- Atomic seed writes (unique temp file + fsync + rename) with corrupt-file
  quarantine, so a crash mid-write cannot strand the app on an unlock screen
  that can never unlock. Legacy single-wallet `seed.json` migrates once at boot.
- macOS keychain-helper build script derives its paths from the script
  location instead of a hardcoded absolute path.

### Notes

- Key material lives only in the isolated signer `utilityProcess`; the renderer
  and main process never hold the seed or secret key.
- Release binaries are currently UNSIGNED. Windows SmartScreen and macOS
  Gatekeeper will warn on first launch; signing/notarization is a follow-up.
