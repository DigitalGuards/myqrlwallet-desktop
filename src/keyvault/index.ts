/**
 * Cross-platform OS-bound storage for the key-encryption-key (KEK).
 *
 * This is DEFENSE-IN-DEPTH, never the root of trust. The honest position
 * (ARCHITECTURE_RESEARCH.md, Chrome App-Bound-Encryption bypass history): OS
 * app-binding raises attacker cost and generates detection signal, but the
 * Argon2id password-derived KEK is what actually protects the seed against
 * same-context malware. A KeyVault that stores the KEK only lets the user skip
 * re-typing the password; it is always optional.
 *
 * Platform asymmetry, per the research:
 *  - macOS: STRONG. Keychain ACL is bound to the app's Designated Requirement
 *    automatically, and kSecAccessControlUserPresence adds a Touch ID/passcode
 *    gate. Implemented via a bundled signed Swift helper.
 *  - Windows: safeStorage wraps with per-user DPAPI (same-user readable; v1
 *    interim, the ABE-equivalent SYSTEM service is v2).
 *  - Linux: libsecret has no per-app access control (CVE-2018-19358 "design
 *    problem"); treated as no better than the password. Default: NullVault.
 */
export interface KeyVault {
  /** Human label for diagnostics/UI ("macOS Keychain (Touch ID)"). */
  readonly label: string;
  /** Whether this vault gates retrieval on hardware user-presence. */
  readonly hardwareBacked: boolean;
  /** Whether the vault can be used at all on this build (signed, available). */
  isAvailable(): Promise<boolean>;
  /** Store (or replace) the KEK for `account`. `kekHex` is wiped by the caller. */
  store(account: string, kekHex: string): Promise<void>;
  /** Retrieve the KEK hex, prompting for user-presence where applicable. Null if absent. */
  retrieve(account: string): Promise<string | null>;
  has(account: string): Promise<boolean>;
  delete(account: string): Promise<void>;
}

export { createKeyVault } from './factory';
