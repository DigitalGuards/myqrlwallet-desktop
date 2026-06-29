/**
 * macOS Keychain vault with Designated-Requirement binding + user presence.
 *
 * Why a native helper and not @napi-rs/keyring / keytar: keytar is archived and
 * never supported access-control flags; @napi-rs/keyring only writes plain
 * generic-password items and does not surface SecAccessControl. So we ship a
 * tiny signed Swift binary (`native/macos-keychain/KeychainHelper.swift`,
 * built to `resources/qrl-keychain-helper`) that calls:
 *   SecAccessControlCreateWithFlags(kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
 *                                   .userPresence)  -> kSecAttrAccessControl
 *   SecItemAdd / SecItemCopyMatching (kSecClassGenericPassword)
 *
 * DR binding is AUTOMATIC for the creating signed app (Apple TN2206): no code
 * is needed for it; other apps cannot read the item without matching our code
 * signature. The user-presence flag adds the Touch ID / passcode prompt. Both
 * only work reliably in a properly codesigned + notarized build, so this vault
 * declares itself unavailable in unsigned/dev runs and the app falls back to
 * password-only unlock.
 *
 * Helper protocol (argv[1] = verb), KEK transferred as hex on stdin/stdout so
 * it never appears in argv / process listings:
 *   store <service> <account>            (reads kek-hex from stdin) -> "ok"
 *   get   <service> <account> <reason>   -> kek-hex on stdout (prompts)
 *   has   <service> <account>            -> "yes" | "no"
 *   delete <service> <account>           -> "ok"
 * Exit code 0 on success; non-zero with a short message on stderr otherwise.
 */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import type { KeyVault } from './index';

const SERVICE = 'com.digitalguards.qrlwallet.desktop.kek';

export interface MacKeychainOptions {
  /** Absolute path to the compiled, signed helper binary. */
  helperPath: string;
  /** True only when running a packaged, code-signed build. */
  signed: boolean;
}

export class MacKeychainVault implements KeyVault {
  readonly label = 'macOS Keychain (Touch ID / passcode, app-bound)';
  readonly hardwareBacked = true;

  constructor(private readonly opts: MacKeychainOptions) {}

  async isAvailable(): Promise<boolean> {
    if (process.platform !== 'darwin' || !this.opts.signed) return false;
    try {
      await fs.access(this.opts.helperPath);
      return true;
    } catch {
      return false;
    }
  }

  private run(args: string[], stdin?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        this.opts.helperPath,
        args,
        { timeout: 60_000, maxBuffer: 1024 * 64 },
        (err, stdout, stderr) => {
          if (err) {
            reject(new Error(stderr?.toString().trim() || err.message));
            return;
          }
          resolve(stdout.toString().trim());
        },
      );
      if (stdin !== undefined && child.stdin) {
        // Guard against a broken pipe (helper exits early): without this an
        // EPIPE on stdin would throw as an unhandled error and crash main.
        child.stdin.on('error', () => undefined);
        child.stdin.end(stdin);
      }
    });
  }

  async store(account: string, kekHex: string): Promise<void> {
    await this.run(['store', SERVICE, account], kekHex);
  }

  async retrieve(account: string): Promise<string | null> {
    try {
      const out = await this.run(['get', SERVICE, account, 'Unlock your QRL wallet']);
      return out || null;
    } catch {
      // user cancelled the biometric prompt, or item absent
      return null;
    }
  }

  async has(account: string): Promise<boolean> {
    try {
      return (await this.run(['has', SERVICE, account])) === 'yes';
    } catch {
      return false;
    }
  }

  async delete(account: string): Promise<void> {
    await this.run(['delete', SERVICE, account]).catch(() => undefined);
  }
}
