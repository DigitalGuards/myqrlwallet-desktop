import { useNativeLanguage, type NativeLanguageBridge } from '../shared/useNativeLanguage';
import type { MessageKey } from '../shared/i18n';
import { StrictMode, useEffect, useState, type SyntheticEvent } from 'react';
import { createRoot } from 'react-dom/client';
// Self-hosted variable fonts, the same faces the wallet renderer uses
// (myqrlwallet-frontend): Sora = display, Instrument Sans = body, JetBrains
// Mono = data (addresses). Imported here so Vite rewrites the woff2 URLs and
// emits them as local assets: no remote load, and the window CSP stays as it
// is (font-src 'self' data:).
import '@fontsource-variable/sora/index.css';
import '@fontsource-variable/instrument-sans/index.css';
import '@fontsource-variable/jetbrains-mono/index.css';
import './unlock.css';
import logoUrl from './logo.png';
import { formatQrlAddressFingerprint } from '../shared/address';

interface UnlockResult {
  ok: boolean;
  errorKey?: MessageKey;
}

interface UnlockWalletInfo {
  address: string;
  keychainBacked: boolean;
}

interface UnlockBridge extends NativeLanguageBridge {
  getInfo(): Promise<{ wallets: UnlockWalletInfo[]; active: string | null }>;
  submit(password: string, address?: string): Promise<UnlockResult>;
  biometric(address?: string): Promise<UnlockResult>;
}

declare global {
  interface Window {
    unlockBridge: UnlockBridge;
  }
}

function UnlockApp() {
  const { t } = useNativeLanguage(window.unlockBridge, 'unlock.title');
  const [wallets, setWallets] = useState<UnlockWalletInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState(false);

  const selectedWallet = wallets.find((w) => w.address === selected) ?? null;
  const keychain = selectedWallet?.keychainBacked ?? false;

  useEffect(() => {
    let cancelled = false;
    window.unlockBridge
      .getInfo()
      .then((info) => {
        if (cancelled) return;
        setWallets(info.wallets);
        setSelected(info.active ?? info.wallets[0]?.address ?? null);
      })
      .catch(() => {
        /* best-effort: the password field still works without the account chip */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit(event?: SyntheticEvent) {
    event?.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.unlockBridge.submit(password, selected ?? undefined);
      if (!result.ok) {
        setError(result.errorKey ?? 'unlock.incorrect');
        setPassword('');
        setBusy(false);
      }
      // On success, main closes this window; keep the spinner up until it does.
    } catch {
      setError('unlock.failed');
      setBusy(false);
    }
  }

  async function biometric() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.unlockBridge.biometric(selected ?? undefined);
      if (!result.ok) {
        setError(result.errorKey ?? 'unlock.biometricFailed');
        setBusy(false);
      }
    } catch {
      setError('unlock.biometricFailed');
      setBusy(false);
    }
  }

  return (
    <div className="unlock-root">
      <main className="unlock-card">
        <img className="unlock-logo" src={logoUrl} alt="" aria-hidden="true" />
        <h1 className="unlock-wordmark">MyQRLWallet</h1>
        {wallets.length > 1 ? (
          <select
            className="unlock-account-select"
            aria-label={t('unlock.account')}
            title={selected ?? undefined}
            value={selected ?? ''}
            disabled={busy}
            onChange={(event) => {
              setSelected(event.target.value);
              if (error) setError(null);
            }}
          >
            {wallets.map((w) => (
              <option key={w.address} value={w.address}>
                {formatQrlAddressFingerprint(w.address)}
              </option>
            ))}
          </select>
        ) : null}
        <form className="unlock-form" onSubmit={(event) => void submit(event)}>
          <div className="unlock-input-wrap">
            <input
              autoFocus
              className="unlock-input"
              type={show ? 'text' : 'password'}
              placeholder={t('unlock.password')}
              aria-label={t('unlock.password')}
              value={password}
              disabled={busy}
              onChange={(event) => {
                setPassword(event.target.value);
                if (error) setError(null);
              }}
            />
            <button
              type="button"
              className="unlock-eye"
              tabIndex={-1}
              onClick={() => setShow((value) => !value)}
            >
              {t(show ? 'unlock.hide' : 'unlock.show')}
            </button>
          </div>
          {error && <p className="unlock-error">{t(error)}</p>}
          <button className="unlock-button" type="submit" disabled={busy || password.length === 0}>
            {t(busy ? 'unlock.busy' : 'unlock.submit')}
          </button>
          {keychain && (
            <button
              className="unlock-biometric"
              type="button"
              disabled={busy}
              onClick={() => void biometric()}
            >
              {t('unlock.touchId')}
            </button>
          )}
        </form>
        <p className="unlock-hint">{t('unlock.recovery')}</p>
      </main>
    </div>
  );
}

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <UnlockApp />
    </StrictMode>,
  );
}
