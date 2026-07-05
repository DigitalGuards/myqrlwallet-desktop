# Changelog

All notable changes to the MyQRLWallet desktop app are documented here.

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
