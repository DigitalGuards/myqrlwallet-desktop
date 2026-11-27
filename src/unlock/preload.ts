/**
 * Preload for the desktop unlock window. Runs sandboxed + context-isolated like
 * the main window's preload, exposing ONLY a narrow unlock surface over
 * contextBridge. No key material crosses here: the password is sent to main,
 * which forwards it to the isolated signer. Raw ipcRenderer is never exposed.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { Language } from '../shared/language';
import type { MessageKey } from '../shared/i18n';

export interface UnlockWalletInfo {
  address: string;
  keychainBacked: boolean;
}

const api = {
  getLanguage: (): Promise<Language> => ipcRenderer.invoke('unlock:getLanguage'),
  onLanguageChanged: (callback: (language: Language) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, language: unknown) => {
      // Keep sandboxed preload entries self-contained: shared runtime imports
      // create chunks that the sandbox cannot require.
      if (
        language === 'en' ||
        language === 'de' ||
        language === 'es' ||
        language === 'ru' ||
        language === 'zh-CN'
      )
        callback(language);
    };
    ipcRenderer.on('wallet:languageChanged', listener);
    return () => {
      ipcRenderer.removeListener('wallet:languageChanged', listener);
    };
  },
  /** Every wallet on this device + the active one (drives the account picker). */
  getInfo: (): Promise<{ wallets: UnlockWalletInfo[]; active: string | null }> =>
    ipcRenderer.invoke('unlock:getInfo'),
  /** Attempt a password unlock of `address` (or the active wallet when omitted).
   * Resolves `{ ok }` so the UI shows errors inline. */
  submit: (
    password: string,
    address?: string,
  ): Promise<{ ok: boolean; error?: string; errorKey?: MessageKey }> =>
    ipcRenderer.invoke('unlock:submit', { password, address }),
  /** Attempt an OS-keychain (Touch ID / device) unlock of `address`. */
  biometric: (address?: string): Promise<{ ok: boolean; error?: string; errorKey?: MessageKey }> =>
    ipcRenderer.invoke('unlock:biometric', { address }),
};

contextBridge.exposeInMainWorld('unlockBridge', api);

// ---- Colour theme (styling only) -------------------------------------------
// Sets data-theme="light" on <html> for the light colour set and removes it for
// dark; the stylesheet keys on that attribute. The resolved theme comes from
// the creation-time argument (first frame), then from main's pull and push.
// Each value is checked against the literal list and anything else is ignored.
// Nothing here is exposed to the page, and a failure leaves the dark set on
// with the bridge above already mounted.
const THEME_ARGUMENT = '--qrl-theme=';
let wantedTheme: 'dark' | 'light' | null = null;
let themeObserver: MutationObserver | null = null;
function paintTheme(): boolean {
  // Null while the preload runs: <html> does not exist yet.
  const root = document.querySelector('html');
  if (!root || wantedTheme === null) return false;
  if (wantedTheme === 'light') root.setAttribute('data-theme', 'light');
  else root.removeAttribute('data-theme');
  return true;
}
function applyTheme(resolved: unknown): void {
  if (resolved !== 'dark' && resolved !== 'light') return;
  wantedTheme = resolved;
  if (paintTheme() || themeObserver) return;
  // The preload runs before <html> exists: paint as soon as the parser adds
  // it, before the page's first script and its first frame.
  const observer = new MutationObserver(() => {
    if (paintTheme()) {
      observer.disconnect();
      themeObserver = null;
    }
  });
  themeObserver = observer;
  observer.observe(document, { childList: true });
}
function resolvedTheme(raw: unknown): unknown {
  return typeof raw === 'object' && raw !== null ? Reflect.get(raw, 'resolved') : undefined;
}
try {
  const argument = process.argv.find((entry) => entry.startsWith(THEME_ARGUMENT));
  if (argument !== undefined) applyTheme(argument.slice(THEME_ARGUMENT.length));
  ipcRenderer.on('wallet:themeChanged', (_event: Electron.IpcRendererEvent, raw: unknown) => {
    applyTheme(resolvedTheme(raw));
  });
  ipcRenderer.invoke('unlock:getTheme').then(
    (raw: unknown) => {
      applyTheme(resolvedTheme(raw));
    },
    () => undefined,
  );
} catch {
  // Styling only: the window keeps the dark colour set.
}
