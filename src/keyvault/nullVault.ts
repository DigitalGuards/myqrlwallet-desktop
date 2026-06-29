import type { KeyVault } from './index';

/**
 * The no-op vault: never persists the KEK, so the password is always required.
 * This is the correct default on Linux (libsecret offers no per-app access
 * control) and the safe fallback anywhere the stronger vaults are unavailable.
 */
export class NullVault implements KeyVault {
  readonly label = 'none (password required every unlock)';
  readonly hardwareBacked = false;
  async isAvailable(): Promise<boolean> {
    return false;
  }
  async store(): Promise<void> {
    /* intentionally nothing */
  }
  async retrieve(): Promise<string | null> {
    return null;
  }
  async has(): Promise<boolean> {
    return false;
  }
  async delete(): Promise<void> {
    /* intentionally nothing */
  }
}
