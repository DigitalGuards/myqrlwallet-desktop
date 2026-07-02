# Threat Model

This is an honest accounting of what the wallet protects, who it protects
against, what each control buys, and where each control stops. The tone follows
the decision document (`docs/ARCHITECTURE_RESEARCH.md`): OS app-binding is
cost-raising and detection-generating, not a guarantee. The Argon2id-derived
password is the real protection.

## Assets

| Asset | Where it lives | Sensitivity |
|---|---|---|
| Mnemonic | Inside the encrypted seed blob at rest; materialised only in the signer during import. | Critical: full account recovery. |
| Hex extended seed (51 bytes) | Inside the encrypted blob at rest; materialised in the signer during a signature. | Critical: derives the ML-DSA-87 secret key, can sign any spend. |
| ML-DSA-87 secret key (4896 bytes) | Derived in the signer from the hex seed, per operation, zeroized immediately. | Critical: signs transactions/messages. |
| KEK (256-bit) | Derived from the password via Argon2id; held in the signer session while unlocked; optionally wrapped into the OS keychain. | Critical: unwraps the seed. |
| User password | Supplied per unlock; never persisted, never logged. | Critical: derives the KEK. |
| Encrypted seed file | `userData` dir, `0600`, AES-256-GCM, salt + KDF params alongside. | Sensitive at rest: an Argon2id-hardened blob. |

## Trust boundaries

Trust runs lowest to highest. Each arrow is a boundary that is sender-validated
and schema-validated.

```
network/dApp -> renderer -> [contextBridge] -> preload -> [IPC] -> main -> [parentPort] -> signer
  (untrusted)  (untrusted)                     (bridge)            (broker)               (key holder)
```

- Renderer is treated as fully untrusted (it renders network content and runs a
  large dependency tree).
- The contextBridge exposes only `QrlWalletApi` (`src/shared/bridge.ts`).
- Main validates every IPC sender (`isTrustedSender`) and parses every argument
  (zod, `.strict()`) before acting (`src/main/ipc.ts`).
- The signer is reachable only from main, over `parentPort`. The renderer has no
  handle to it.

## Attacker model and what each control buys (and its limits)

### A. Same-user malware / infostealer (no code injection)

Other code running as the same OS user, reading files and calling OS APIs, but
not injecting into our signed process.

- Control: encrypted seed at rest. AES-256-GCM under an Argon2id-derived KEK
  (`KDF_DEFAULTS`: Argon2id, 256 MiB, t=3; `src/shared/constants.ts`,
  `src/signer/kdf.ts`, `src/signer/aead.ts`). File is `0600`
  (`src/main/seedFile.ts`).
- Buys: stealing the file yields only an Argon2id-hardened blob. Offline cracking
  is bounded by the memory-hard KDF; a strong password is infeasible to brute.
- Limit: a weak password is crackable offline once the file is exfiltrated. The
  KDF cost is the only thing standing between the attacker and the seed. This is
  why the password is the load-bearing control and why `calibrate:kdf` must be
  run and the parameters frozen near 500 ms on target hardware.

- Control: OS app-binding of the KEK as defense-in-depth.
  - macOS `MacKeychainVault` (`src/keyvault/macKeychainVault.ts`): KEK stored
    with `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, an ACL bound to our
    Designated Requirement (Team ID + cdhash, automatic for the signed app), and
    `kSecAccessControlUserPresence` (Touch ID / passcode).
  - Windows/Linux `SafeStorageVault` (`src/keyvault/safeStorageVault.ts`): DPAPI
    / login-keychain / libsecret wrap, off by default
    (`QRL_ALLOW_SAFESTORAGE=1`, `src/main/index.ts`).
- Buys: on macOS, a same-user infostealer that does not inject into our signed
  binary cannot export the KEK, and user-presence forces an interactive Touch ID
  prompt. This is where app-binding genuinely pulls its weight.
- Limits, stated honestly:
  - (c) Linux libsecret has NO per-application access control (CVE-2018-19358,
    ruled a desktop design problem, not a bug): any app can read any secret while
    the keyring is unlocked. So the default vault on Linux (and Windows, unless
    opted in) is `NullVault` (`src/keyvault/nullVault.ts`, selected by
    `src/keyvault/factory.ts`): the user types the password on every unlock and
    no KEK is stored. We do not lean on libsecret for anti-exfiltration.
  - (d) macOS user-presence and DR binding only work reliably in a properly
    code-signed + notarized build. `MacKeychainVault.isAvailable()` returns false
    in unsigned/dev runs (`signed: app.isPackaged`), so the app falls back to
    password-only unlock there.

### B. Renderer remote code execution (renderer RCE)

A malicious page or injected script achieves arbitrary code execution inside the
renderer (the failure class behind the competitor-wallet RCE that motivated this
design).

- Control: the renderer holds no keys, has no Node, is sandboxed, and its only
  reachable surface is `QrlWalletApi`. Containment is the full hardening
  checklist (`SECURITY.md`): `contextIsolation`, `sandbox`,
  `nodeIntegration: false`, strict CSP (no `unsafe-inline`/`unsafe-eval`), IPC
  sender + schema validation, navigation lockdown, fuses, ASAR integrity.
- Buys: a fully compromised renderer can request a signature, but only over a
  specific payload that the user must approve in the main-drawn confirmation
  modal (`src/main/confirm.ts`). The two renderer-reachable DESTRUCTIVE
  primitives are gated the same way: signing and wallet removal
  (`REMOVE_WALLET`) each require a main-drawn confirmation (`confirmSignature` /
  `confirmRemoveWallet`, `src/main/confirm.ts`), so a compromised renderer can
  neither sign nor irreversibly wipe the encrypted seed without a trusted prompt
  it cannot draw over. The unlock password is collected in a main-owned native
  window (`src/unlock/`, `src/main/unlockWindow.ts`), not the renderer, so a
  compromised renderer cannot draw a fake unlock screen or keylog the real
  password. The renderer cannot read the seed, reach the signer, touch disk, or
  exfiltrate over the network beyond the CSP `connect-src` allowlist. It yields
  no key material.
- Limit: the renderer can still ask for signatures. The trusted confirmation
  modal is the backstop. If the user blindly approves a malicious payload, the
  signature is produced. Also, context isolation can be defeated by an unpatched
  V8 type-confusion bug (the "V8 patch gap"), so keeping Electron/Chromium
  current is itself a control.

### C. Evil dApp payload

A connected dApp sends a crafted signing request hoping the wallet signs
something the user did not intend.

- Control: all signing requests are zod-validated discriminated unions
  (`SignatureRequestSchema`, `src/shared/schemas.ts`), bounded in size, and
  routed through the trusted main-drawn confirmation modal before signing.
  Domain-separation context tags (`SCHEME.TAG_MSG` / `TAG_TYPED`) byte-match the
  wallet/SDK so a message signature cannot be repurposed as a transaction
  signature.
- Buys: malformed/oversized inputs are rejected at the boundary; the user sees
  what is being signed in a context the dApp cannot draw over.
- Limit: typed-data (`qrl_signTypedData`) signing is intentionally NOT wired in
  this scaffold (`src/signer/index.ts` fails loudly rather than emit a signature
  over a digest the dApp side would not reproduce). The byte-exact EIP-712-style
  hasher must be ported from `myqrlwallet-frontend src/utils/signing/typedData.ts`
  before enabling it. Until then, typed-data requests error out by design.

### D. Supply chain

A malicious dependency or a tampered build artifact.

- Control: lockfile-pinned deps; pure-NAPI/JS crypto (no native build step to
  subvert); the spend path is confined to the Halborn-audited `@theqrl/mldsa87`;
  unaudited `@noble/post-quantum` is kept off the spend path entirely. Releases
  are Authenticode-signed (Windows), notarized (macOS), and PGP-detach-signed
  (all platforms). ASAR integrity + `OnlyLoadAppFromAsar` fuse mean the app only
  loads code from the signed archive.
- Buys: a tampered artifact fails signature verification; a swapped dependency is
  caught by the lockfile; users can verify the PGP `.asc` sidecars.
- Limit: signing proves provenance, not the absence of a malicious upstream
  commit. Dependency review and reproducible builds (a Stage 3 goal) are the
  real defenses against a compromised upstream.

### E. Hostile qrlconnect:// protocol launch (drive-by pairing)

The app registers the OS-wide `qrlconnect://` scheme (dApp-connect ingress), so
ANY webpage or same-user process can fire connection URIs at the wallet without
the physical-scan consent the mobile flow gets for free. The attacker's goals:
pair silently (learn the active account address via the handshake's
WALLET_INFO), or spam the wallet with pairing prompts.

- Control, layered (`src/main/dappUri.ts`, `src/main/index.ts`): the browser's
  own "open MyQRLWallet?" prompt; main shape-validates the URI (scheme, 4KB
  cap, visible-ASCII only) and never parses the payload; a 2s rate limit drops
  launch floods (buffer depth 1); the renderer then shows an explicit consent
  modal BEFORE any relay contact. Only after consent does the audited
  dApp-connect stack (fingerprint pinning, ML-KEM handshake) run.
- Buys: no silent pairing, no address disclosure without a user click, no
  consent-modal spam, and main cannot be crashed by a malformed URI (parsing
  stays in the renderer's single hostile-input parser).
- Limit: the consent modal cannot verify WHO is asking (dApp identity arrives
  only after the handshake, in ORIGINATOR_INFO), so it shows the relay origin
  and asks "did you just click Connect in a dApp?". A user who consents to an
  unexpected prompt has paired with the attacker's channel; the signature
  confirm modal (which shows the dApp-supplied identity and main-computed tx
  facts) remains the gate for anything that spends. Signature-request
  provenance is renderer-supplied and labelled unverified in the confirm
  dialog (`DAppOriginSchema`, `src/main/confirm.ts`).

## Honest tradeoffs already noted in the code

These are the specific, acknowledged weaknesses. Each maps to a code path.

### (a) The KEK transits main when provisioning the OS keychain

When `importWallet` is called with `useKeychain: true`, the signer derives the
KEK, exports it as hex, and returns it to main, which writes it into the OS
keychain (`src/main/ipc.ts` `IMPORT_WALLET`, calling `keyVault.store`). For that
window the KEK exists as a JS string in the main process, outside the signer
isolation boundary.

- Why it is accepted: this is the only way to seed the OS keychain, and the
  keychain is defense-in-depth, not the primary control. The code minimises the
  KEK's lifetime by dropping the only reference immediately after the store, and
  the comment at the call site flags the tradeoff.
- Residual risk: a main-process compromise during that narrow window could read
  the KEK. The Argon2id password remains the protection of last resort.

### (b) The hex seed is an un-zeroizable V8 string during a signature

The hex extended seed is handled as a JavaScript string in the signer for the
duration of a signature (`src/signer/signing.ts`; passed to
`web3.qrl.accounts.signTransaction` and `newWalletFromExtendedSeed`). V8 strings
are immutable and garbage-collected; they cannot be reliably overwritten in
place.

- Why it is accepted: the audited `@theqrl/*` and web3 APIs take the seed as a
  string; converting around that would diverge from the audited path. The
  `Wallet` object's secret-key buffer IS zeroized (`wallet.zeroize()` in every
  `finally`), and the KEK and the decrypted seed buffer ARE wiped
  (`src/signer/zeroize.ts`).
- Scope is deliberately minimised: the recovery mnemonic and the hex signing
  seed are encrypted in SEPARATE envelopes under the same KEK
  (`EncryptedSeed.seed` vs `EncryptedSeed.mnemonic`, `src/shared/protocol.ts`).
  The signing path decrypts and string-materialises ONLY the hex seed
  (`SignerSession.withSeed`/`withSeedAsync`); the mnemonic, the most
  catastrophic secret, is never decrypted on the hot signing path, only on an
  explicit export/backup operation.
- Residual risk: a memory scrape of the signer during a signature could recover
  the hex seed string before GC reclaims it. This is the residual that hardware
  signing (a future stage) would close.

### (c) Linux libsecret has no per-app access control: default is NullVault

Covered under attacker model A above. `src/keyvault/factory.ts` selects
`NullVault` on Linux by default, so the user enters the password on every unlock
and no KEK is stored where another app could read it.

### (d) macOS user-presence only works in signed + notarized builds

Covered under attacker model A above. `MacKeychainVault.isAvailable()` gates on
`app.isPackaged`, so dev/unsigned builds transparently fall back to
password-only unlock rather than offering a Touch ID prompt that the OS would not
actually bind to our code identity.

`app.isPackaged` is a COARSE proxy: an ad-hoc-signed packaged build would also
pass it without a stable Developer ID Designated Requirement. This does not
create a leak, because the macOS Keychain enforces the DR binding at access time
(items created without a stable DR fail to round-trip; another identity cannot
read them). A hardening follow-up is to verify the running code signature
(SecCode / `codesign`) before declaring the vault available, instead of trusting
`app.isPackaged` alone (`src/keyvault/factory.ts`).

### (e) OS app-binding is defeatable by same-context code execution

This is the central honest caveat. App-binding (ours, and Chrome's
App-Bound Encryption that inspired it) is defeated once an attacker executes code
in, or injects into, the trusted process. The historical record is explicit:
Chrome's ABE has been bypassed in the wild by DLL/COM injection into the trusted
process, by Chrome's own remote-debugging port, by VoidStealer's
hardware-breakpoint read of the key while briefly in plaintext, and by CyberArk's
C4 padding-oracle attack that peeled the CBC-mode SYSTEM-DPAPI layer in roughly
16 hours. Google's own framing is that ABE shifts attacker behavior toward more
observable techniques (injection, memory scraping), which is why they are moving
to hardware binding (TPM / Secure Enclave, DBSC).

- Implication for this wallet: treat `MacKeychainVault` and `SafeStorageVault` as
  cost-raising and detection-generating, never as a guarantee. The Argon2id
  password is what actually protects the seed when same-context malware wins. We
  communicate this to users and do not oversell "app-bound" storage.
- Steering: high-value Linux users should use full-disk encryption plus a
  hardware wallet; hardware-wallet / air-gapped signing is a planned stage for
  all platforms.

### (f) The renderer is served from `file://`, so the file-protocol fuse stays at its permissive default

The packaged renderer loads via `loadFile` (`src/main/index.ts`), and a
`file`-scheme handler remaps the frontend's root-absolute asset paths and
attaches the strict CSP header (`installFileProtocolHandler`). Because the app
legitimately depends on
`file://`, the `afterPack` hook leaves `GrantFileProtocolExtraPrivileges` at
Electron's default (enabled): it sets the six security-relevant fuses explicitly
but does not flip this one. That default grants `file://` pages extra powers
(fetch over `file://`, service-worker registration, broad child-frame access)
that Electron recommends disabling in favor of a registered custom scheme.

- Why it is accepted for now: this is NOT a regression from the Electron 42 bump
  (the fuse defaulted enabled on the prior major too), and disabling it while the
  renderer is still served from `file://` would break asset loading. The
  load-bearing renderer controls (sandbox, `contextIsolation`, `script-src 'self'`
  with no inline/eval, navigation lockdown, deny-by-default permissions) are
  unaffected and still contain a renderer compromise.
- Residual risk: an in-origin renderer RCE has the broader `file://` capability
  surface available rather than a minimal custom-scheme one.
- Hardening follow-up: migrate the renderer to a registered privileged custom
  scheme (`protocol.handle` / `registerSchemesAsPrivileged`), then flip
  `GrantFileProtocolExtraPrivileges: false` in `scripts/afterPack.cjs` (the two
  must land together). Consider `strictlyRequireAllFuses: true` so a future
  Electron major that lengthens the fuse wire fails the build loudly instead of
  silently leaving a new fuse at its default.
