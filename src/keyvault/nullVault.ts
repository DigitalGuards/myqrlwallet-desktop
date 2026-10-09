import type { KeyVault } from './index';

/**
 * The no-op vault: never persists the KEK, so the password is always required.
 * This is the correct default on Linux (libsecret offers no per-app access
 * control) and the safe fallback anywhere the stronger vaults are unavailable.
 */
export class NullVault implements KeyVault {
  readonly label = 'none (password required every unlock)';
  readonly hardwareBacked = false;
  isAvailable(): Promise<boolean> {
    return Promise.resolve(false);
  }
  store(): Promise<void> {
    return Promise.resolve(); // intentionally nothing
  }
  retrieve(): Promise<string | null> {
    return Promise.resolve(null);
  }
  has(): Promise<boolean> {
    return Promise.resolve(false);
  }
  delete(): Promise<void> {
    return Promise.resolve(); // intentionally nothing
  }
}
