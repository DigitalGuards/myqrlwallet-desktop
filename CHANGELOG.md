# Changelog

All notable changes to the MyQRLWallet desktop app are documented here.

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
