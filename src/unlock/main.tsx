import { StrictMode, useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import './unlock.css';
import logoUrl from './logo.png';

interface UnlockResult {
  ok: boolean;
  error?: string;
}

interface UnlockBridge {
  getInfo(): Promise<{ address: string | null; keychainBacked: boolean }>;
  submit(password: string): Promise<UnlockResult>;
  biometric(): Promise<UnlockResult>;
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
  const [address, setAddress] = useState<string | null>(null);
  const [keychain, setKeychain] = useState(false);
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    window.unlockBridge
      .getInfo()
      .then((info) => {
        if (cancelled) return;
        setAddress(info.address);
        setKeychain(info.keychainBacked);
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
      const result = await window.unlockBridge.submit(password);
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
      const result = await window.unlockBridge.biometric();
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
        <div className="unlock-account">
          <span className="unlock-dot" />
          {shortAddress(address)}
        </div>
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
