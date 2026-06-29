# MyQRLWallet Desktop — Post-Quantum, Enterprise-Grade Architecture Decision Document

## TL;DR
- **Build on Electron, not Tauri** — and bundle the wallet as a local app (not a thin remote webview). The audited cryptography you depend on (theQRL/qrypto.js, Halborn-audited ML-DSA-87) is JavaScript and signature-only; a Tauri/Rust core would force you to either reimplement lattice signatures (unaudited, reckless) or FFI-wrap JS/Go (which throws away Rust's safety benefit). Notably, your north-star reference, RAILGUN's Railway Wallet, is itself Electron — so the "pinnacle" you admire already validates this path.
- **Make a mandatory user password + Argon2id + AES-256-GCM the load-bearing control, with OS app-binding as defense-in-depth.** Chrome's App-Bound Encryption is worth replicating, but be honest: ABE has already been bypassed in the wild (CyberArk's C4 padding-oracle decrypted the SYSTEM-DPAPI blob in ~16 hours, plus COM-injection, remote-debugging, and VoidStealer's debugger trick). OS app-binding raises attacker cost and generates detection signal, but a password-derived key is what actually protects the seed when same-context malware wins.
- **Enforce strict process/privilege separation: the renderer never touches key material.** Signing happens in a dedicated isolated Node.js process running qrypto.js; the renderer (your reused React frontend) can only request a signature over a specific, user-confirmed payload and gets one back. Combine with contextIsolation, sandbox, nodeIntegration:false, a strict CSP, and IPC allowlisting to contain the renderer-RCE class you personally know is real.

## Key Findings

### The audited-JS constraint decides the framework
theQRL/qrypto.js was audited by Halborn, with results released April 3, 2026. Per theQRL's official press release (Zug, Switzerland): "The audit found no cryptographic vulnerabilities. All 13 findings were rated Informational, the lowest severity level, and the core signing, verification and key generation logic was validated as correct." Halborn's audit page confirms the scope as `@theqrl/mldsa87` v1.1.1 (ML-DSA-87 / FIPS 204, NIST Level 5) and `@theqrl/dilithium5` v1.1.1, and the engagement included a 2.4-million-input fuzzing campaign with zero false accepts. This is a **signature-only** library — it cannot serve as a KEM or AEAD.

There is no equivalently audited Rust implementation of QRL's PQC. `@noble/post-quantum` (which provides ML-KEM-768 and ML-DSA-87 in JS) is explicitly **not independently audited** — its maintainer notes only a self-audit and "no protection against side-channel attacks." go-qrllib is Go and reached 100% coverage, but was not the subject of the same external signature audit.

The implication is decisive: **the one audited, blessed signing path is JavaScript.** A Rust-core architecture (Tauri's main selling point) cannot use it natively. You would have to (a) reimplement ML-DSA-87 in Rust unaudited — unacceptable for a wallet — or (b) FFI-bridge to JS or Go from Rust, at which point the memory-safety argument for Rust evaporates and you've added a brittle, audit-invisible boundary. Electron keeps the audited signer (qrypto.js) running in its native habitat (Node.js/V8) with no foreign-function boundary around the cryptography.

### Railway Wallet (your north star) is Electron, and its patterns are directly replicable
My research confirms Railway Wallet's desktop app is **Electron**, not Tauri: release v5.24.16 explicitly notes "Improved security configuration for Electron," and the Linux artifacts it ships (`.deb`, `.snap`, `.pacman`, `.AppImage`, `.rpm`, each with a detached PGP `.asc` signature) are the electron-builder Linux target set. The repo is a monorepo with `desktop/` and `mobile/` folders sharing a TypeScript/React (React-Native-Web) frontend. Replicable patterns:
- **Self-custody key handling:** verbatim from railway.xyz — "As a Self Custody wallet, only you have access to your accounts. When you generate a wallet in Railway, the seed phrase is encrypted with your password and only stored on your local machine. Absolutely zero logs of user activity are collected." The RAILGUN engine docs reinforce the discipline: "The BIP39 mnemonic password is not stored by the engine. The caller owns it and must supply it again to loadExistingWallet() and to every spend." Wallet data is held in an encrypted local LevelDB store.
- **Heavy crypto off the UI thread:** on mobile they run the RAILGUN engine/proof generation in a bundled `nodejs-mobile-react-native` sidecar; on desktop the engine runs in the Node.js/WASM context. The key architectural lesson: *the cryptographic engine runs in a Node process distinct from the rendering UI.*
- **Configurable RPC:** verbatim — "Users have the ability to fully configure the RPCs they choose to use." Directly relevant to your self-sovereign vision. (No Tor transport found in Railway; that would be your differentiator.)
- **Signed, multi-format distribution** via electron-builder with PGP-signed release artifacts.

One gap my deep-dive could not verify from source: Railway's exact `webPreferences` security flags and exact KDF/cipher. So treat their config as confirmation that Electron-with-hardening is viable, but design your own hardening from first principles (below).

### DPAPI is the wrong primitive; Chrome's App-Bound Encryption is the right *pattern* (with caveats)
Windows DPAPI (`CryptProtectData`/`CryptUnprotectData`) binds ciphertext to the user logon session — so **any process running as the user, including an infostealer, can call `CryptUnprotectData` and recover plaintext.** (The `CRYPTPROTECT_LOCAL_MACHINE` flag is worse: any user on the machine can decrypt.) This is precisely why infostealers harvested Chrome cookies for years.

Chrome 127 introduced **App-Bound Encryption (ABE)** to fix this; Google's Security Blog post "Improving the security of Chrome cookies on Windows" was published July 30, 2024. Mechanism: a per-app AES-256 key (the `app_bound_key`, prefixed `APPB` in Local State) is wrapped by a privileged **Elevation Service** (`elevation_service.exe`) running as **NT AUTHORITY\SYSTEM**. The service wraps the key in both SYSTEM-DPAPI and user-DPAPI and, critically, **validates the calling executable's identity (initially by path) before unwrapping** — so a different process running as the user cannot get the plaintext key. Google's stated goal, in its words: "Now, the malware has to gain system privileges, or inject code into Chrome, something that legitimate software shouldn't be doing."

**But ABE is not a panacea, and you must design knowing this.** Documented in-the-wild and research bypasses include: DLL/COM injection into the trusted process (xaitax's tooling, IElevator/IElevator2), Chrome's own remote-debugging port (Phemedrone), and VoidStealer's hardware-breakpoint read of the key while it's briefly in plaintext. Most striking is CyberArk Labs' **C4** ("Chrome Cookie Cipher Cracker"): a padding-oracle attack that abuses Windows Event Viewer as the oracle to peel off the CBC-mode SYSTEM-DPAPI layer — full decryption "took around 16 hours." CyberArk's conclusion: "It might be time to consider CBC insecure." Google's own framing of the cat-and-mouse dynamic (via spokesperson) is telling: "we expect this protection to cause a shift in attacker behavior to more observable techniques such as injection or memory scraping" — i.e., ABE raises cost and noise, it does not make exfiltration impossible. That is exactly why Google is now moving to hardware binding: per the Google Security Blog (April 2026), "Device Bound Session Credentials (DBSC) is now entering public availability for Windows users on Chrome 146, and expanding to macOS in an upcoming Chrome release," using the **TPM** on Windows and the **Secure Enclave** on macOS.

### macOS and Linux app-binding are very asymmetric
- **macOS Keychain is genuinely strong** for this goal. A keychain item's ACL is bound by default to the creating app's **Designated Requirement (DR)** — i.e., your Team ID + code-signing identifier/cdhash — so other apps can't export it without injecting into your signed binary. You can additionally require user presence (Touch ID/passcode) via `kSecAccessControl` (`kSecAccessControlUserPresence`), pin to `...ThisDeviceOnly`, and wrap the key-encryption-key in the **Secure Enclave**; ACLs are evaluated inside the Secure Enclave and released to the kernel only if constraints are met. This is the closest OS-native analogue to ABE and is the platform where app-binding actually pulls its weight.
- **Linux secret storage is weak.** libsecret/Secret Service (gnome-keyring/kwallet) offers **no meaningful per-application access control**. Per CVE-2018-19358 (Red Hat Bugzilla #1652194): "Any application can easily read any secret if the keyring is unlocked. And, if a user is logged in, then the login/default collection is unlocked." Red Hat Product Security ruled it "not a security vulnerability, but a design problem in the Linux desktop," and GNOME's stated position is that "untrusted applications must not be allowed to communicate with the secret service." You cannot lean on it for anti-exfiltration.

### Renderer-RCE containment is a solved problem if you follow discipline
Your competitor-wallet RCE finding is the common Electron failure mode: untrusted/injected content in a renderer that can reach Node. The mitigations are well-established: `contextIsolation: true` (default since Electron 12), `nodeIntegration: false`, `sandbox: true`, a strict CSP (no `unsafe-eval`, no `unsafe-inline`), a minimal `contextBridge` API surface, validation of every IPC message's sender and schema in the main process, denying navigation/window-open to external origins, and keeping Chromium patched (the "v8 patch gap" means context isolation can be defeated by an unpatched V8 type-confusion bug, so update cadence is itself a security control). Crucially, even a fully compromised renderer must yield **no key material**, because keys never live there.

## Details

### Recommended architecture: Electron, bundled-local, four-tier privilege separation

**Framework: Electron (high confidence).** Rationale: preserves the audited qrypto.js signing path with no FFI around the cryptography; matches the actual (Electron) architecture of your north-star Railway Wallet; gives consistent Chromium CSP/sandbox behavior across OSes (Tauri's per-OS WebView — WKWebView/WebView2/WebKitGTK — makes CSP and rendering security non-uniform); and lets you reuse the existing React frontend and Node tooling directly. Tauri's genuine advantages (smaller binary, Rust memory safety, capability-by-default) do not outweigh the cardinal requirement of keeping the audited signer intact. *Threshold that would change this recommendation:* a credibly audited Rust ML-DSA-87 (e.g., an audited RustCrypto `ml-dsa`, or a Rust qrypto port for which theQRL commissions an audit). Until then, Electron.

**Topology: bundled local application, not a thin webview.** Load the UI from local files (`loadFile`), not a remote `loadURL`; bundle the frontend assets, the qrypto.js signer, and a local RPC proxy. The thin-webview model (what the mobile app currently does) means your security posture depends on a remote server and a live TLS channel for the app shell itself — unacceptable for a key-holding desktop wallet and incompatible with your offline/self-sovereign goal. The bundled-local model puts the seed offline-and-local, keeps the attack surface auditable in the signed bundle, and is the foundation for the configurable-RPC/proxy/Tor vision.

**Four processes, strict trust gradient (lowest → highest trust):**
1. **Renderer (untrusted):** the reused `myqrlwallet-frontend` React app. No Node, no keys, `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`. Talks only through a minimal preload bridge.
2. **Preload (contextBridge):** exposes a small, parameterized, validated API — e.g., `wallet.getBalance(addr)`, `wallet.buildTransaction(params)`, `wallet.requestSignature(unsignedTxHash)`, `wallet.unlock(passwordHandle)`. No raw `ipcRenderer` pass-through, no `require`, no `fs`/`child_process`.
3. **Main process (broker):** window/lifecycle management, IPC sender+schema validation, the bundled RPC proxy, and orchestration. Holds **no** plaintext keys. Draws the transaction-confirmation modal in a trusted context so the renderer cannot spoof "what is being signed."
4. **Signer `utilityProcess` (highest trust):** a dedicated, locked-down Node.js process that is the *only* place plaintext key material exists, and only transiently. It performs Argon2id KDF, unwraps the OS-app-bound KEK, decrypts the seed (AES-256-GCM), derives the ML-DSA-87 key via qrypto.js, signs the exact payload, and **zeroizes** buffers immediately after. It exposes a single narrow IPC verb ("sign this, after main confirms user approved").

This means: seed lives encrypted on disk; decryption and signing happen only inside the signer process; the renderer can at most *ask* for a signature over a specific, user-confirmed payload.

### Cross-platform secure-storage design (improving on DPAPI)

**Root of trust (all platforms): password-derived key.** Derive a 256-bit key-encryption-key (KEK) from the user password with **Argon2id** (memory-hard; tune to ≥500 ms on target hardware, as Sparrow Wallet does with its Argon2 configuration). Encrypt the seed/mnemonic with **AES-256-GCM** (authenticated) using a key wrapped by that KEK. This single control means that *even if every OS app-binding layer is defeated by same-context malware, the attacker still only gets an Argon2id-hardened blob.* This is the honest lesson from ABE's bypasses.

**Layer OS app-binding on top as defense-in-depth (raises cost + generates detection signal):**
- **Windows — ABE-equivalent.** The faithful replica is a small **privileged Windows service running as SYSTEM** that exposes a COM or named-pipe interface, validates the caller (by image path *and* Authenticode signature via `WinVerifyTrust` — go beyond Chrome's initial path-only check, which the C4 work showed was the weak entry point), and wraps/unwraps the KEK with SYSTEM-DPAPI. Combine with **TPM-backed sealing** via CNG/`NCrypt` (key non-exportable, optionally sealed to PCRs) to approximate Chrome's newer hardware-bound DBSC direction. Pragmatic v1 interim: per-user DPAPI wrap of the KEK *plus* the mandatory password (so DPAPI's weakness is backstopped). Document explicitly that the password — not DPAPI — is the real protection.
- **macOS — Keychain bound to your code identity.** Store the KEK (or a Secure-Enclave-wrapped KEK) as a keychain item with `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, an ACL bound to your app's Designated Requirement (Team ID + cdhash), and `kSecAccessControl` requiring user presence (Touch ID) for spend operations. Use the Secure Enclave to hold a non-exportable wrapping key. This is where app-binding genuinely defeats same-user infostealers.
- **Linux — do not trust libsecret.** Treat the password-derived key as the *sole* real protection. Optionally seal the KEK to a **TPM 2.0** (tpm2-tss) bound to PCRs where available; store ciphertext in a file with `0600` perms under a restricted app data dir. Be transparent in docs that Linux cannot match macOS/Windows app-binding, and recommend full-disk encryption + hardware wallet for high-value Linux users.

**For any encryption needs (not signing):** use `@noble/post-quantum` ML-KEM-768 for PQ key encapsulation and WebCrypto AES-256-GCM + HKDF-SHA-256 for symmetric/derivation — **but flag prominently that noble-post-quantum is not independently audited**; confine it to non-consensus, non-spend paths (e.g., optional encrypted local backups, P2P transport), never the spend-authorization path, which stays exclusively on Halborn-audited qrypto.js.

### Renderer hardening checklist (the RCE-in-renderer class)
- `webPreferences`: `contextIsolation: true`, `nodeIntegration: false`, `nodeIntegrationInWorker: false`, `sandbox: true`, `webSecurity: true`, `allowRunningInsecureContent: false`, a dedicated `preload`.
- **Strict CSP** delivered via header/meta: `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' <allowed RPC origins>; object-src 'none'; frame-ancestors 'none'; base-uri 'none'` — no `unsafe-eval`, no `unsafe-inline`.
- **Preload discipline:** expose only high-level parameterized actions; no `exec`/`spawn`/`fs`/`require`/`eval`; no raw `ipcRenderer`.
- **IPC defense-in-depth:** in every `ipcMain.handle`, validate `event.senderFrame`/origin against an allowlist and validate arguments against a schema; re-validate in the signer process.
- **Navigation lockdown:** `will-navigate` → `preventDefault` for external; `setWindowOpenHandler` → deny by default; guard `shell.openExternal` to https + allowlisted hosts.
- **Supply chain & updates:** pin/lockfile + audit dependencies, package via electron-builder, **code-sign (Windows Authenticode) and notarize (macOS)**, PGP-sign release artifacts (as Railway does), ship signed auto-updates, and keep Electron/Chromium current to close the V8 patch gap.
- Disable DevTools and the remote module in production builds; enable ASAR integrity.

### Maximizing reuse of the existing stack
- **`myqrlwallet-frontend` (React):** reuse directly as the renderer UI — this is the primary reuse win. Refactor only the key-touching code paths to call the new `contextBridge` API instead of doing crypto in-page.
- **`myqrlwallet-backend` (RPC proxy):** fold its logic into the bundled main-process local proxy. This is exactly the substrate for your "configurable RPC + bundled proxy + optional Tor" vision — the desktop app becomes its own backend.
- **`myqrlwallet-app` (mobile webview wrapper):** useful precedent for sharing the React layer, but the desktop build should go *further* than the thin-webview model — local bundle, local seed, local signing.
- **qrypto.js (`@theqrl/mldsa87`):** the canonical signer in the utilityProcess. **zondscan** is low relevance (explorer) beyond optionally powering an in-app explorer view.

### QRL-specific gaps that constrain the design
- **No audited non-JS PQC.** The only externally signature-audited implementation is JS (qrypto.js/Halborn); noble-post-quantum is unaudited; go-qrllib is Go without the same external signature audit. This is the single biggest architectural constraint and is the reason Electron wins.
- **Signature-only primitive.** ML-DSA-87 via qrypto.js cannot provide KEM/AEAD; any encryption must come from separate (less-assured) libraries, so keep encryption off the spend-critical path.
- **ML-KEM for P2P is still in development** at theQRL as of mid-2026 (current node P2P identity uses classical crypto by design), so don't assume a PQ-secure transport exists yet — bundle your own (e.g., ML-KEM-768 hybrid over TLS) if you need PQ network confidentiality, and treat it as unaudited.
- **Legacy XMSS → ML-DSA migration** runs through a precompile/bridge; the desktop wallet should target the Zond/ML-DSA-87 world but keep the migration UX in mind (OTS-key tracking is a known footgun on legacy QRL).

## Recommendations

**Stage 1 — v1 secure foundation (ship first):**
1. Electron app, monorepo with `desktop/` reusing `myqrlwallet-frontend`; UI loaded from local bundle (`loadFile`).
2. Four-process separation; implement the signer `utilityProcess` running qrypto.js as the sole key-touching component; renderer fully sandboxed and key-free.
3. Seed at rest: Argon2id (≥500 ms) + AES-256-GCM; mandatory user password gates every spend.
4. OS keychain as defense-in-depth: macOS Keychain bound to Designated Requirement (do this properly in v1 — high-value, low-cost); Windows interim per-user DPAPI wrap of the KEK; Linux file + `0600` and clear docs.
5. Full renderer-hardening checklist; code-sign + notarize + PGP-sign releases; signed auto-update.
*Exit criterion to Stage 2:* external pentest of the IPC/preload boundary passes; no path from renderer to plaintext key.

**Stage 2 — v2 hardened storage + signing UX:**
1. Windows ABE-equivalent: SYSTEM privileged service validating caller path **and** Authenticode signature, SYSTEM-DPAPI + TPM/CNG sealing.
2. macOS Secure Enclave-wrapped KEK + Touch ID user-presence on spend; Linux TPM2 sealing where available.
3. Trusted-context, main-process-drawn transaction confirmation ("you are signing X to Y"); optional hardware-wallet / air-gapped PSBT-style signing flow for high-value users (Sparrow's warm/cold split is the model).
*Exit criterion to Stage 3:* independent review confirms a same-user infostealer cannot exfiltrate a usable seed without injecting into the signed process (and that such injection is detectable).

**Stage 3 — v3 self-sovereign:**
1. Bundle the RPC proxy; expose configurable RPC (Railway-style) with per-network selection.
2. Optional **Tor** routing (bundle `tor`/Arti) and SOCKS proxy support for network-layer privacy — your differentiator vs. Railway.
3. Fully offline/air-gapped mode; **reproducible builds** so users can verify the signed bundle.

**Decision thresholds that would change the above:**
- *Audited Rust ML-DSA-87 ships* → re-evaluate a Tauri core with a native signer (revisit framework choice).
- *noble-post-quantum receives a full external audit* → you may promote ML-KEM-768 use into more sensitive paths.
- *theQRL ships a hardware-wallet target / signer* → prioritize that over software key storage for high-value users.

### First build prompt (hand to a coding agent)
> Scaffold an Electron + electron-builder monorepo (`desktop/`, reusing the React app from `DigitalGuards/myqrlwallet-frontend` as the renderer). Renderer config: `contextIsolation:true`, `nodeIntegration:false`, `sandbox:true`, strict CSP (`default-src 'self'`, no `unsafe-eval/inline`), UI loaded via `loadFile`. Add a `preload.ts` exposing only `wallet.getBalance`, `wallet.buildTransaction`, `wallet.requestSignature`, `wallet.unlock` via `contextBridge`. Spawn a `utilityProcess` "signer" that is the ONLY holder of plaintext keys: it derives a KEK from the user password with Argon2id (≥500ms), decrypts the seed with AES-256-GCM, signs with `@theqrl/mldsa87` (ML-DSA-87), and zeroizes buffers. Main process validates every IPC sender+schema and draws the transaction-confirmation modal. Store the encrypted seed in an app-data file; on macOS additionally store the KEK in Keychain bound to the app's Designated Requirement with `kSecAccessControlUserPresence`. Code-sign (Authenticode), notarize (macOS), and PGP-sign release artifacts.

## Caveats
- **OS app-binding (including Chrome's ABE) is defeatable by same-context code execution.** Treat it as cost-raising and detection-generating, never as a guarantee. The Argon2id password remains the real protection; communicate this honestly to users and don't oversell "app-bound" storage.
- **Railway internals partially unverified.** I confirmed Electron, the monorepo `desktop/`+`mobile/` layout, password-encrypted-local-seed, electron-builder/PGP distribution, and configurable RPC from official sources and release notes; I could **not** verify Railway's exact `webPreferences` flags or exact KDF/cipher from source. Your hardening should be designed from first principles, not copied blindly.
- **noble-post-quantum and any custom PQ transport are unaudited**; keep them off the spend-authorization path.
- **Linux cannot match macOS/Windows app-binding** — be explicit with Linux users and steer high-value usage toward FDE + hardware wallets.
- **Some framework-comparison figures circulating in 2026 blog posts (e.g., specific CVE counts, "10x" performance multipliers) are vendor/marketing-flavored**; I relied on them only for directional claims (Tauri smaller/Rust-safe; Electron mature/consistent-CSP), which are well established, not for precise numbers.
- The current QRL 2.0 testnet/mainnet timeline and some ecosystem facts come from project-affiliated sources (theqrl.org, qrlhub) and should be treated as project claims.