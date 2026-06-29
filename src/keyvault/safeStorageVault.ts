/**
 * safeStorage-backed vault (cross-platform, NO user-presence gate).
 *
 * Electron's safeStorage encrypts with an OS-held key: DPAPI (per-user) on
 * Windows, the login keychain on macOS, and libsecret on Linux. We persist the
 * resulting ciphertext to a 0600 file under userData.
 *
 * HONEST CAVEAT (surfaced in the UI and THREAT_MODEL.md): this protects the KEK
 * from OTHER apps / at rest, but NOT from other code running as the SAME user,
 * and it never prompts for Touch ID/passcode. It is the Windows v1 "interim
 * per-user DPAPI wrap" from the research, and a convenience layer only. The
 * macOS user-presence path lives in MacKeychainVault.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';
import type { KeyVault } from './index';

export class SafeStorageVault implements KeyVault {
  readonly label = 'OS safeStorage (no Touch ID; same-user readable)';
  readonly hardwareBacked = false;

  constructor(private readonly dir: string) {}

  private file(account: string): string {
    // account is a validated Q-address; safe as a filename component.
    return path.join(this.dir, `kek-${account}.bin`);
  }

  async isAvailable(): Promise<boolean> {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  async store(account: string, kekHex: string): Promise<void> {
    const enc = safeStorage.encryptString(kekHex);
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.file(account), enc, { mode: 0o600 });
  }

  async retrieve(account: string): Promise<string | null> {
    try {
      const enc = await fs.readFile(this.file(account));
      return safeStorage.decryptString(enc);
    } catch {
      return null;
    }
  }

  async has(account: string): Promise<boolean> {
    try {
      await fs.access(this.file(account));
      return true;
    } catch {
      return false;
    }
  }

  async delete(account: string): Promise<void> {
    await fs.rm(this.file(account), { force: true });
  }
}
