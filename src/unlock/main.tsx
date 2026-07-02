import { StrictMode, useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import './unlock.css';
import logoUrl from './logo.png';

interface UnlockResult {
  ok: boolean;
  error?: string;
}

interface UnlockWalletInfo {
  address: string;
  keychainBacked: boolean;
}

interface UnlockBridge {
  getInfo(): Promise<{ wallets: UnlockWalletInfo[]; active: string | null }>;
  submit(password: string, address?: string): Promise<UnlockResult>;
  biometric(address?: string): Promise<UnlockResult>;
}

declare global {
  interface Window {
    unlockBridge: UnlockBridge;
  }
}

function shortAddress(address: string | null): string {
  if (!address) return 'your wallet';
  return address.length > 16 ? `${address.slice(0, 10)}...${address.slice(-4)}` : address;
}

function UnlockApp() {
  const [wallets, setWallets] = useState<UnlockWalletInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.unlockBridge.submit(password, selected ?? undefined);
      if (!result.ok) {
        setError(result.error ?? 'Incorrect password. Please try again.');
        setPassword('');
        setBusy(false);
      }
      // On success, main closes this window; keep the spinner up until it does.
    } catch {
      setError('Unlock failed. Please try again.');
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
        setError(result.error ?? 'Biometric unlock failed.');
        setBusy(false);
      }
    } catch {
      setError('Biometric unlock failed.');
      setBusy(false);
    }
  }

  return (
    <div className="unlock-root">
      <main className="unlock-card">
        <img className="unlock-logo" src={logoUrl} alt="" aria-hidden="true" />
        <h1 className="unlock-wordmark">MyQRLwallet</h1>
        <p className="unlock-subtitle">Enter your password to unlock</p>
        {wallets.length > 1 ? (
          <select
            className="unlock-account-select"
            aria-label="Account to unlock"
            value={selected ?? ''}
            disabled={busy}
            onChange={(event) => {
              setSelected(event.target.value);
              if (error) setError(null);
            }}
          >
            {wallets.map((w) => (
              <option key={w.address} value={w.address}>
                {shortAddress(w.address)}
              </option>
            ))}
          </select>
        ) : (
          <div className="unlock-account">
            <span className="unlock-dot" />
            {shortAddress(selected)}
          </div>
        )}
        <form className="unlock-form" onSubmit={(event) => void submit(event)}>
          <div className="unlock-input-wrap">
            <input
              autoFocus
              className="unlock-input"
              type={show ? 'text' : 'password'}
              placeholder="Password"
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
              {show ? 'Hide' : 'Show'}
            </button>
          </div>
          {error && <p className="unlock-error">{error}</p>}
          <button className="unlock-button" type="submit" disabled={busy || password.length === 0}>
            {busy ? 'Unlocking...' : 'Unlock'}
          </button>
          {keychain && (
            <button
              className="unlock-biometric"
              type="button"
              disabled={busy}
              onClick={() => void biometric()}
            >
              Unlock with Touch ID
            </button>
          )}
        </form>
        <p className="unlock-hint">
          Forgot your password? You will need to re-import your recovery phrase.
        </p>
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
