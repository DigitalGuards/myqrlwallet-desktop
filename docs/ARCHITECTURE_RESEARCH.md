# MyQRLWallet Desktop: Post-Quantum Architecture Decision Document

This document records the architecture rationale and staged proposals. The
Desktop 1.4.7 boundaries below reflect the implementation; later-stage features
remain proposals. See [SECURITY.md](../SECURITY.md) and
[THREAT_MODEL.md](../THREAT_MODEL.md) for the current controls and limits.

## TL;DR
- **Build on Electron and bundle the wallet as a local app.** The existing QRL signing packages run in JavaScript, so Electron preserves their native runtime while reusing the React frontend and Node tooling. RAILGUN's Railway Wallet is another Electron wallet using this distribution model.
- **Protect stored wallet envelopes with a password-derived Argon2id KEK and AES-256-GCM.** The OS keychain can protect access to a saved KEK according to its platform policy. Whoever obtains the KEK can decrypt both recovery envelopes without knowing or cracking the password. Password strength protects stolen envelopes while that KEK remains secret.
- **Keep ordinary desktop unlock and signing in the isolated signer.** The renderer requests a signature over a specific payload and main requires trusted user confirmation. Setup and import expose recovery material to the renderer and main. Sandbox, context isolation, disabled Node integration, CSP and IPC validation restrict renderer privileges within the limits below.

Once an account exists, the signer holds decrypted keys and performs signing.
During account setup, the renderer shows a new account's recovery phrase once
for backup. Import forms read typed recovery phrases and hex seeds, and encrypted
wallet files are decrypted in the renderer or its worker. Main brokers these
secrets between the renderer and the signer. A compromised renderer during setup
or import can recover that account.

## Key Findings

### The audited-JS constraint decides the framework
theQRL/qrypto.js was audited by Halborn, with results released April 3, 2026. Per theQRL's official press release (Zug, Switzerland): "The audit found no cryptographic vulnerabilities. All 13 findings were rated Informational, the lowest severity level, and the core signing, verification and key generation logic was validated as correct." Halborn's audit page confirms the scope as `@theqrl/mldsa87` v1.1.1 (ML-DSA-87 / FIPS 204, NIST Level 5) and `@theqrl/dilithium5` v1.1.1, and the engagement included a 2.4-million-input fuzzing campaign with zero false accepts. This is a **signature-only** library - it cannot serve as a KEM or AEAD.

There is no equivalently audited Rust implementation of QRL's PQC. `@noble/post-quantum` (which provides ML-KEM-768 and ML-DSA-87 in JS) is explicitly **not independently audited** - its maintainer notes only a self-audit and "no protection against side-channel attacks." go-qrllib is Go and reached 100% coverage, but was not the subject of the same external signature audit.

The implication is decisive: **the one audited, blessed signing path is JavaScript.** A Rust-core architecture (Tauri's main selling point) cannot use it natively. You would have to (a) reimplement ML-DSA-87 in Rust unaudited - unacceptable for a wallet - or (b) FFI-bridge to JS or Go from Rust, at which point the memory-safety argument for Rust evaporates and you've added a brittle, audit-invisible boundary. Electron keeps the audited signer (qrypto.js) running in its native habitat (Node.js/V8) with no foreign-function boundary around the cryptography.

### Railway Wallet (your north star) is Electron, and its patterns are directly replicable
My research confirms Railway Wallet's desktop app is **Electron**, not Tauri: release v5.24.16 explicitly notes "Improved security configuration for Electron," and the Linux artifacts it ships (`.deb`, `.snap`, `.pacman`, `.AppImage`, `.rpm`, each with a detached PGP `.asc` signature) are the electron-builder Linux target set. The repo is a monorepo with `desktop/` and `mobile/` folders sharing a TypeScript/React (React-Native-Web) frontend. Replicable patterns:
- **Self-custody key handling:** verbatim from railway.xyz - "As a Self Custody wallet, only you have access to your accounts. When you generate a wallet in Railway, the seed phrase is encrypted with your password and only stored on your local machine. Absolutely zero logs of user activity are collected." The RAILGUN engine docs reinforce the discipline: "The BIP39 mnemonic password is not stored by the engine. The caller owns it and must supply it again to loadExistingWallet() and to every spend." Wallet data is held in an encrypted local LevelDB store.
- **Heavy crypto off the UI thread:** on mobile they run the RAILGUN engine/proof generation in a bundled `nodejs-mobile-react-native` sidecar; on desktop the engine runs in the Node.js/WASM context. The key architectural lesson: *the cryptographic engine runs in a Node process distinct from the rendering UI.*
- **Configurable RPC:** verbatim - "Users have the ability to fully configure the RPCs they choose to use." Directly relevant to your self-sovereign vision. (No Tor transport found in Railway; that would be your differentiator.)
- **Signed, multi-format distribution** via electron-builder with PGP-signed release artifacts.

One gap my deep-dive could not verify from source: Railway's exact `webPreferences` security flags and exact KDF/cipher. So treat their config as confirmation that Electron-with-hardening is viable, but design your own hardening from first principles (below).

### DPAPI is the wrong primitive; Chrome's App-Bound Encryption is the right *pattern* (with caveats)
Windows DPAPI (`CryptProtectData`/`CryptUnprotectData`) binds ciphertext to the user logon session - so **any process running as the user, including an infostealer, can call `CryptUnprotectData` and recover plaintext.** (The `CRYPTPROTECT_LOCAL_MACHINE` flag is worse: any user on the machine can decrypt.) This is precisely why infostealers harvested Chrome cookies for years.

Chrome 127 introduced **App-Bound Encryption (ABE)** to fix this; Google's Security Blog post "Improving the security of Chrome cookies on Windows" was published July 30, 2024. Mechanism: a per-app AES-256 key (the `app_bound_key`, prefixed `APPB` in Local State) is wrapped by a privileged **Elevation Service** (`elevation_service.exe`) running as **NT AUTHORITY\SYSTEM**. The service wraps the key in both SYSTEM-DPAPI and user-DPAPI and, critically, **validates the calling executable's identity (initially by path) before unwrapping** - so a different process running as the user cannot get the plaintext key. Google's stated goal, in its words: "Now, the malware has to gain system privileges, or inject code into Chrome, something that legitimate software shouldn't be doing."

**But ABE is not a panacea, and you must design knowing this.** Documented in-the-wild and research bypasses include: DLL/COM injection into the trusted process (xaitax's tooling, IElevator/IElevator2), Chrome's own remote-debugging port (Phemedrone), and VoidStealer's hardware-breakpoint read of the key while it's briefly in plaintext. Most striking is CyberArk Labs' **C4** ("Chrome Cookie Cipher Cracker"): a padding-oracle attack that abuses Windows Event Viewer as the oracle to peel off the CBC-mode SYSTEM-DPAPI layer - full decryption "took around 16 hours." CyberArk's conclusion: "It might be time to consider CBC insecure." Google's own framing of the cat-and-mouse dynamic (via spokesperson) is telling: "we expect this protection to cause a shift in attacker behavior to more observable techniques such as injection or memory scraping" - i.e., ABE raises cost and noise, it does not make exfiltration impossible. That is exactly why Google is now moving to hardware binding: per the Google Security Blog (April 2026), "Device Bound Session Credentials (DBSC) is now entering public availability for Windows users on Chrome 146, and expanding to macOS in an upcoming Chrome release," using the **TPM** on Windows and the **Secure Enclave** on macOS.

### macOS and Linux app-binding are very asymmetric
- **macOS Keychain is genuinely strong** for this goal. A keychain item's ACL is bound by default to the creating app's **Designated Requirement (DR)** - i.e., your Team ID + code-signing identifier/cdhash - so other apps can't export it without injecting into your signed binary. You can additionally require user presence (Touch ID/passcode) via `kSecAccessControl` (`kSecAccessControlUserPresence`), pin to `...ThisDeviceOnly`, and wrap the key-encryption-key in the **Secure Enclave**; ACLs are evaluated inside the Secure Enclave and released to the kernel only if constraints are met. This is the closest OS-native analogue to ABE and is the platform where app-binding actually pulls its weight.
- **Linux secret storage is weak.** libsecret/Secret Service (gnome-keyring/kwallet) offers **no meaningful per-application access control**. Per CVE-2018-19358 (Red Hat Bugzilla #1652194): "Any application can easily read any secret if the keyring is unlocked. And, if a user is logged in, then the login/default collection is unlocked." Red Hat Product Security ruled it "not a security vulnerability, but a design problem in the Linux desktop," and GNOME's stated position is that "untrusted applications must not be allowed to communicate with the secret service." You cannot lean on it for anti-exfiltration.

### Renderer boundaries and setup/import exposure
The renderer has `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, a narrow `contextBridge` API, IPC sender/schema validation and navigation restrictions. These controls restrict native access. Document scripts are limited to the bundle, inline JavaScript and JS `eval` are blocked, and WebAssembly compilation is allowed. The policy also permits HTTPS images to any host and generated blob workers. A compromised renderer can read setup/import recovery material and send it to an outside host. It can also draw a lookalike password prompt and read input supplied to it; the genuine native unlock window stays isolated. Keeping Chromium patched remains necessary because an engine vulnerability can cross these boundaries.

## Details

### Recommended architecture: Electron, bundled-local, four-tier privilege separation

**Framework: Electron (high confidence).** Rationale: preserves the audited qrypto.js signing path with no FFI around the cryptography; matches the actual (Electron) architecture of your north-star Railway Wallet; gives consistent Chromium CSP/sandbox behavior across OSes (Tauri's per-OS WebView - WKWebView/WebView2/WebKitGTK - makes CSP and rendering security non-uniform); and lets you reuse the existing React frontend and Node tooling directly. Tauri's genuine advantages (smaller binary, Rust memory safety, capability-by-default) do not outweigh the cardinal requirement of keeping the audited signer intact. *Threshold that would change this recommendation:* a credibly audited Rust ML-DSA-87 (e.g., an audited RustCrypto `ml-dsa`, or a Rust qrypto port for which theQRL commissions an audit). Until then, Electron.

**Topology: bundled local application.** Serve the bundled UI from separate privileged `app` origins and bundle the frontend assets, signer and main-process RPC client. Wallet envelopes are stored locally. Message and typed-data signing still require the renderer's `assertNetworkReady` check of `qrl_chainId` and genesis over RPC; signing is refused while RPC is unavailable. Typed data with a domain chain ID also waits for a successful RPC lookup to compare it with the wallet chain, with a mismatch shown as a warning. Configurable RPC and Tor remain separate design proposals.

**Four processes, strict trust gradient (lowest → highest trust):**
1. **Renderer (untrusted):** the reused `myqrlwallet-frontend` React app, with `sandbox: true`, `contextIsolation: true` and `nodeIntegration: false`. Shows a new account's recovery phrase once for backup; import forms read typed recovery phrases and hex seeds, and decrypt encrypted wallet files in the renderer or its worker. A compromised renderer during setup or import can recover that account.
2. **Preload (contextBridge):** exposes named `window.qrlWallet` methods for the wallet surface. Setup/import secrets transit this bridge. The separate native unlock window uses `window.unlockBridge.submit` (`unlock:submit`) for password unlock. No raw `ipcRenderer` pass-through, `require`, `fs` or `child_process` is exposed.
3. **Main process (broker):** manages windows, validates IPC senders and schemas, runs the RPC client and stores encrypted wallet envelopes. Brokers setup/import recovery material between renderer and signer, and KEKs between signer and OS keychain. Draws trusted confirmations whose approval gate the renderer cannot bypass.
4. **Signer `utilityProcess` (highest trust):** generates accounts, derives the password KEK with Argon2id, encrypts desktop wallet envelopes, decrypts keys for unlock/signing and signs the confirmed payload. Secret buffers are wiped after use; the unlocked session retains the KEK. Its private protocol accepts create/import/unlock/sign/lock/status operations only through main.

The desktop wallet envelopes are encrypted on disk and ordinary unlock/signing decryption stays in the signer. Setup/import recovery material also passes through the renderer and main. Renderer-side encrypted-wallet-file decryption is part of the supported import flow.

### Cross-platform secure-storage design (improving on DPAPI)

**Stored wallet envelopes: password-derived key.** Derive a 256-bit KEK from the user password with **Argon2id** and encrypt the hex seed and recovery phrase in separate **AES-256-GCM** envelopes directly under that KEK. Password guessing against a stolen file incurs the KDF cost while the attacker lacks the KEK. Keychain-backed unlock saves the same KEK, and main retrieves it for the signer. Whoever obtains the KEK can decrypt both recovery envelopes without knowing or cracking the password. The OS keychain protects access to the saved KEK; it supplies no additional password barrier after KEK recovery.

**Layer OS app-binding on top as defense-in-depth (raises cost + generates detection signal):**
- **Windows: proposed ABE-equivalent.** A future privileged service could validate caller identity and wrap the KEK with SYSTEM-DPAPI or TPM-backed sealing. The current opt-in `SafeStorageVault` uses per-user DPAPI; default Windows unlock uses the password with `NullVault`. Recovering a saved KEK is sufficient to decrypt the envelopes without the password.
- **macOS: keychain access controls.** The helper stores the KEK with `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` and requires user presence for retrieval. A signed build supplies the app identity binding. Retrieval releases the KEK through main to the signer for an unlocked session; anyone who recovers it can decrypt the envelopes without the password. A separate non-exportable Secure Enclave wrapping key remains a proposal.
- **Linux: password unlock by default.** `NullVault` stores no KEK; encrypted wallet files use mode `0600`. Opt-in `SafeStorageVault` depends on the desktop keyring, which lacks per-app access control. Recovering its saved KEK permits envelope decryption without the password. TPM sealing remains a proposal; full-disk encryption adds protection for a powered-off device.

**For any encryption needs (not signing):** use `@noble/post-quantum` ML-KEM-768 for PQ key encapsulation and WebCrypto AES-256-GCM + HKDF-SHA-256 for symmetric/derivation - **but flag prominently that noble-post-quantum is not independently audited**; confine it to non-consensus, non-spend paths (e.g., optional encrypted local backups, P2P transport), never the spend-authorization path, which stays exclusively on Halborn-audited qrypto.js.

### Renderer hardening checklist (the RCE-in-renderer class)
- `webPreferences`: `contextIsolation: true`, `nodeIntegration: false`, `nodeIntegrationInWorker: false`, `sandbox: true`, `webSecurity: true`, `allowRunningInsecureContent: false`, a dedicated `preload`.
- **CSP** delivered via header/meta: `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' <configured RPC/backend origins>; img-src 'self' data: https://<SERVER_HOST>; media-src 'self' blob:; font-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; worker-src 'self'`. Document inline JavaScript, JS `eval` and generated blob workers are blocked. Images use local/data sources or the configured backend/IPFS gateway; other artwork uses a placeholder. The pinned frontend has no executable public IPFS fallback or explorer image dependency. Allowed services, external-browser links, explicit resource hints and WebRTC TCP/proxy paths remain outbound channels. Automatic DNS prefetch and direct WebRTC UDP receive additional restrictions. See the [current policy](../SECURITY.md#2-strict-content-security-policy) and [inventory](RENDERER_CSP_INVENTORY.md).
- **Preload discipline:** expose only high-level parameterized actions; no `exec`/`spawn`/`fs`/`require`/`eval`; no raw `ipcRenderer`.
- **IPC defense-in-depth:** in every `ipcMain.handle`, validate `event.senderFrame`/origin against an allowlist and validate arguments against a schema; re-validate in the signer process.
- **Navigation lockdown:** `will-navigate` → `preventDefault` for external; `setWindowOpenHandler` → deny by default; guard `shell.openExternal` to https + allowlisted hosts.
- **Supply chain & updates:** pin/lockfile + audit dependencies, package via electron-builder, **code-sign (Windows Authenticode) and notarize (macOS)**, PGP-sign release artifacts (as Railway does), ship signed auto-updates, and keep Electron/Chromium current to close the V8 patch gap.
- Disable DevTools and the remote module in production builds. Keep the ASAR-only and integrity fuses enabled. Electron enforces embedded ASAR integrity on macOS and Windows; Linux runs modified JavaScript inside the ASAR, reproduced on Electron 44.9.3 with the release fuse hook.

### Bundled origins and storage upgrade

The `app` scheme is registered before readiness as standard, secure, fetch/CORS
capable, streaming and code-cache capable. CSP bypass and service workers stay
disabled. Separate wallet, unlock and settings origins isolate localStorage,
BroadcastChannel and worker scope. The handler rejects ambiguous paths and
uses realpath containment within each surface's directory, then attaches the
existing CSP, nosniff and DNS-prefetch headers. Wallet root-absolute assets map
to the wallet bundle. This is the move recommended by
[Electron's security checklist](https://www.electronjs.org/docs/latest/tutorial/security#18-avoid-usage-of-the-file-protocol-and-prefer-usage-of-custom-protocols),
and permits `GrantFileProtocolExtraPrivileges: false`.

The one-time localStorage copy runs before the UI. A hidden inert page with its
own preload reads the legacy file origin at the constant URL
`file:///qrlwallet-storage-migration.html`, served from memory independently of
the install path. It copies every localStorage entry with no key filter, keeping
strings unchanged, including empty keys and values. Existing destination keys
are never overwritten. A temporary channel accepts only its live main frame
and expected phase. Verification checks that every legacy key exists and every
key written by this run holds its legacy value. A storage flush precedes the
serialized, atomic settings completion field `walletOriginMigrationV1`.
1.4.5 settings remain valid. The source stays intact. Failures are non-fatal:
startup continues on the new origin, completion stays unset and the next launch
retries while preserving existing destination values. The helpers retain a
30-second bound. Failure logs contain one fixed line without keys, values or
error details. Completed copies are skipped.
Electron 44 blocks file-origin localStorage when the file fuse is off. The
legacy reader alone uses `webSecurity: false`, with sandboxing, context
isolation, disabled Node integration and disabled insecure content retained.
Its response adds a `default-src 'none'` policy and the request filter permits
only its exact main-frame helper document. Main destroys this reader before
creating the destination helper with `webSecurity: true`. The wallet, unlock
and settings surfaces always retain `webSecurity: true`. This temporary
compatibility exception has no frontend scripts or public bridge.

The file handler denies every request after the helper closes. It permits only
the helper's main-frame inert page during migration. Stored values are never
logged. See [the implementation and tests](../SECURITY.md#one-time-wallet-storage-move).

### Maximizing reuse of the existing stack
- **`myqrlwallet-frontend` (React):** reuse as the renderer UI. Desktop generation, envelope encryption, unlock and signing call the native bridges. Setup displays the recovery phrase, and import reads recovery material and decrypts encrypted wallet files in the renderer or its worker before main brokers the secrets to the signer.
- **`myqrlwallet-backend` (RPC proxy):** fold its logic into the bundled main-process local proxy. This is exactly the substrate for your "configurable RPC + bundled proxy + optional Tor" vision - the desktop app becomes its own backend.
- **`myqrlwallet-app` (mobile webview wrapper):** useful precedent for sharing the React layer, but the desktop build should go *further* than the thin-webview model - local bundle, local seed, local signing.
- **qrypto.js (`@theqrl/mldsa87`):** the canonical signer in the utilityProcess. **zondscan** is low relevance (explorer) beyond optionally powering an in-app explorer view.

### QRL-specific gaps that constrain the design
- **No audited non-JS PQC.** The only externally signature-audited implementation is JS (qrypto.js/Halborn); noble-post-quantum is unaudited; go-qrllib is Go without the same external signature audit. This is the single biggest architectural constraint and is the reason Electron wins.
- **Signature-only primitive.** ML-DSA-87 via qrypto.js cannot provide KEM/AEAD; any encryption must come from separate (less-assured) libraries, so keep encryption off the spend-critical path.
- **ML-KEM for P2P is still in development** at theQRL as of mid-2026 (current node P2P identity uses classical crypto by design), so don't assume a PQ-secure transport exists yet - bundle your own (e.g., ML-KEM-768 hybrid over TLS) if you need PQ network confidentiality, and treat it as unaudited.
- **Legacy XMSS → ML-DSA migration** runs through a precompile/bridge; the desktop wallet should target the Zond/ML-DSA-87 world but keep the migration UX in mind (OTS-key tracking is a known footgun on legacy QRL).

## Recommendations

This roadmap retains proposed features such as signed releases, automatic
updates and hardware-backed storage. The implemented boundaries are described
above; inclusion in a stage does not establish that a feature has shipped.

**Stage 1 - v1 secure foundation (ship first):**
1. Electron app, monorepo with `desktop/` reusing `myqrlwallet-frontend`; UI served from local bundles at `app://wallet`, `app://unlock` and `app://settings`.
2. Process separation: the signer holds decrypted keys for ordinary unlock and signing. The sandboxed renderer and main handle setup/import recovery material as described above.
3. Seed at rest: Argon2id + AES-256-GCM. A password or saved KEK opens a signer session; trusted confirmation gates each signature. KEK recovery permits envelope decryption without the password.
4. OS keychain as defense-in-depth: macOS Keychain bound to Designated Requirement (do this properly in v1 - high-value, low-cost); Windows interim per-user DPAPI wrap of the KEK; Linux file + `0600` and clear docs.
5. Full renderer-hardening checklist; code-sign + notarize + PGP-sign releases; signed auto-update.
*Review criterion for Stage 2:* assess the IPC/preload boundary and explicitly include setup/import recovery-material exposure, renderer phishing and CSP exfiltration paths. The current renderer handles plaintext recovery material during setup/import.

**Stage 2 - v2 hardened storage + signing UX:**
1. Windows ABE-equivalent: SYSTEM privileged service validating caller path **and** Authenticode signature, SYSTEM-DPAPI + TPM/CNG sealing.
2. macOS Secure Enclave-wrapped KEK + Touch ID user-presence on spend; Linux TPM2 sealing where available.
3. Trusted-context, main-process-drawn transaction confirmation ("you are signing X to Y"); optional hardware-wallet / air-gapped PSBT-style signing flow for high-value users (Sparrow's warm/cold split is the model).
*Exit criterion to Stage 3:* independent review confirms a same-user infostealer cannot exfiltrate a usable seed without injecting into the signed process (and that such injection is detectable).

**Stage 3 - v3 self-sovereign:**
1. Bundle the RPC proxy; expose configurable RPC (Railway-style) with per-network selection.
2. Optional **Tor** routing (bundle `tor`/Arti) and SOCKS proxy support for network-layer privacy - your differentiator vs. Railway.
3. A future disconnected or air-gapped signing mode requires changes to the renderer's current RPC prerequisites. **Reproducible builds** would let users verify the distributed bundle.

**Decision thresholds that would change the above:**
- *Audited Rust ML-DSA-87 ships* → re-evaluate a Tauri core with a native signer (revisit framework choice).
- *noble-post-quantum receives a full external audit* → you may promote ML-KEM-768 use into more sensitive paths.
- *theQRL ships a hardware-wallet target / signer* → prioritize that over software key storage for high-value users.

### First build prompt (hand to a coding agent)
> Reuse the React frontend in a local Electron bundle with sandbox, context isolation and disabled Node integration. Expose named native bridge methods and validate IPC senders and schemas. Keep desktop envelope encryption, ordinary unlock and signing in the signer utility process, with trusted main-drawn confirmation before signatures. Document that setup shows the recovery phrase, import forms read recovery phrases and hex seeds, encrypted wallet files decrypt in the renderer or its worker, and main brokers these secrets. A compromised renderer during setup or import can recover that account. Use the CSP and platform-specific ASAR limits described above. Store wallet envelopes under an Argon2id-derived KEK and state that recovery of a saved KEK permits decryption without the password. Native password unlock uses `window.unlockBridge.submit` through `unlock:submit`. Signing through the bundled renderer retains its RPC prerequisites. Configure signing and notarization separately from the current unsigned release process.

## Caveats
- **OS app-binding is defeatable by same-context code execution.** It controls access to a saved KEK according to platform policy. Whoever obtains the KEK can decrypt both recovery envelopes without knowing or cracking the password, including when it is read from main during provisioning or keychain unlock.
- **Railway internals partially unverified.** I confirmed Electron, the monorepo `desktop/`+`mobile/` layout, password-encrypted-local-seed, electron-builder/PGP distribution, and configurable RPC from official sources and release notes; I could **not** verify Railway's exact `webPreferences` flags or exact KDF/cipher from source. Your hardening should be designed from first principles, not copied blindly.
- **noble-post-quantum and any custom PQ transport are unaudited**; keep them off the spend-authorization path.
- **Linux cannot match macOS/Windows app-binding** - be explicit with Linux users and steer high-value usage toward FDE + hardware wallets.
- **Some framework-comparison figures circulating in 2026 blog posts (e.g., specific CVE counts, "10x" performance multipliers) are vendor/marketing-flavored**; I relied on them only for directional claims (Tauri smaller/Rust-safe; Electron mature/consistent-CSP), which are well established, not for precise numbers.
- The current QRL 2.0 testnet/mainnet timeline and some ecosystem facts come from project-affiliated sources (theqrl.org, qrlhub) and should be treated as project claims.
