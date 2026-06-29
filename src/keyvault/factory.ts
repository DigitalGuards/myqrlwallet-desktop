/**
 * Selects the strongest KeyVault available on this platform/build.
 *
 *   macOS, signed build, helper present  -> MacKeychainVault (user-presence)
 *   else, if the user opts in            -> SafeStorageVault (no presence gate)
 *   else                                 -> NullVault (password every unlock)
 *
 * The choice is resolved lazily (isAvailable is async) so callers should await
 * `resolve()` once at startup and cache the result.
 */
import path from 'node:path';
import { app } from 'electron';
import type { KeyVault } from './index';
import { MacKeychainVault } from './macKeychainVault';
import { NullVault } from './nullVault';
import { SafeStorageVault } from './safeStorageVault';

export interface KeyVaultOptions {
  /** When false (default), the SafeStorageVault convenience layer is not used
   * and only the macOS user-presence vault or NullVault are considered. */
  allowSafeStorageFallback?: boolean;
}

/**
 * Build the candidate vaults. `createKeyVault` returns a small resolver so the
 * async availability checks run at most once.
 */
export function createKeyVault(opts: KeyVaultOptions = {}): { resolve(): Promise<KeyVault> } {
  let cached: Promise<KeyVault> | null = null;

  const helperPath = path.join(process.resourcesPath ?? app.getAppPath(), 'qrl-keychain-helper');
  // `signed: app.isPackaged` is a COARSE proxy: it distinguishes a packaged app
  // from a `electron .` dev run, but does not itself prove a non-ad-hoc
  // Developer ID signature. The real protection does not depend on this flag:
  // the macOS Keychain enforces the Designated-Requirement binding at access
  // time, so an ad-hoc/unsigned build simply cannot retrieve another identity's
  // items, and a build with no stable DR will fail to round-trip its own. A
  // hardening follow-up is to verify the running code signature (SecCode /
  // codesign) before declaring the vault available. See THREAT_MODEL.md.
  const mac = new MacKeychainVault({ helperPath, signed: app.isPackaged });
  const safe = new SafeStorageVault(path.join(app.getPath('userData'), 'keyvault'));
  const none = new NullVault();

  async function pick(): Promise<KeyVault> {
    if (await mac.isAvailable()) return mac;
    if (opts.allowSafeStorageFallback && (await safe.isAvailable())) return safe;
    return none;
  }

  return {
    resolve(): Promise<KeyVault> {
      if (!cached) cached = pick();
      return cached;
    },
  };
}
