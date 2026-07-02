# Changelog

All notable changes to the MyQRLWallet desktop app are documented here.

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
