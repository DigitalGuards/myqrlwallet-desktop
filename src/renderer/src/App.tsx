/**
 * Demo / reference renderer for MyQRLWallet.
 *
 * GOAL: prove the full IPC flow end to end and show other devs exactly how a
 * renderer is expected to consume `window.qrlWallet`. Every privileged action
 * goes through that bridge object. There is deliberately no other I/O here.
 *
 * The bridge is mounted by the preload via contextBridge. We import the shared
 * `bridge` module purely for its `declare global` augmentation of `Window`, so
 * `window.qrlWallet` is fully typed below. The `schemas` import gives us the
 * request/response types that cross the process boundary; reusing them here
 * means the demo cannot drift from what main actually validates.
 */
import { useCallback, useEffect, useState } from 'react';
import '../../shared/bridge'; // side-effect: augments `window.qrlWallet` typing
import type {
  BalanceResult,
  FeeLevel,
  SignatureResult,
  UnsignedTransaction,
  WalletStatus,
} from '../../shared/schemas';

// `window.qrlWallet` is the entire trusted surface. Alias it once so every call
// site reads as a plain method call and the dependency is obvious.
const wallet = window.qrlWallet;

/** Pull a human-readable message out of a rejected invoke (or anything). */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return 'Unknown error';
  }
}

/** mm:ss countdown helper for the auto-lock timer. */
function formatRemaining(ms: number): string {
  if (ms <= 0) return '0:00';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes)}:${String(seconds).padStart(2, '0')}`;
}

export function App(): React.JSX.Element {
  const [status, setStatus] = useState<WalletStatus | null>(null);
  const [hasWallet, setHasWallet] = useState<boolean | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);

  // Initial load: read status + provisioning state, and subscribe to lock
  // changes (auto-lock fires this with `locked: true`). The bridge returns an
  // unsubscribe function we must call on unmount.
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [s, hw] = await Promise.all([wallet.getStatus(), wallet.hasWallet()]);
        if (!active) return;
        setStatus(s);
        setHasWallet(hw);
      } catch (err) {
        if (active) setBootError(errorMessage(err));
      }
    })();

    const unsubscribe = wallet.onLockStateChanged((locked) => {
      // Re-pull authoritative status rather than synthesising it locally; the
      // boolean is just the trigger.
      void wallet.getStatus().then((s) => {
        setStatus(s);
        void locked;
      });
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  // A single place for children to refresh status + provisioning after an action.
  const refresh = useCallback(async () => {
    const [s, hw] = await Promise.all([wallet.getStatus(), wallet.hasWallet()]);
    setStatus(s);
    setHasWallet(hw);
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">Q</span>
          <span className="brand-name">MyQRLWallet</span>
          <span className="brand-tag">desktop reference renderer</span>
        </div>
        <StatusPill status={status} />
      </header>

      <main className="content">
        {bootError !== null && (
          <div className="banner banner-error" role="alert">
            Failed to initialise: {bootError}
          </div>
        )}

        {status === null || hasWallet === null ? (
          <div className="card">
            <p className="muted">Loading wallet state.</p>
          </div>
        ) : !hasWallet ? (
          <ImportView onDone={refresh} />
        ) : status.locked ? (
          <UnlockView onDone={refresh} />
        ) : (
          <UnlockedView status={status} onDone={refresh} />
        )}
      </main>

      <footer className="footer">
        <span className="muted">
          All privileged actions flow through <code>window.qrlWallet</code>. Keys never enter this
          renderer.
        </span>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status pill
// ---------------------------------------------------------------------------

function StatusPill({ status }: { status: WalletStatus | null }): React.JSX.Element {
  if (status === null) {
    return <span className="pill pill-neutral">connecting</span>;
  }
  if (!status.hasWallet) {
    return <span className="pill pill-neutral">no wallet</span>;
  }
  if (status.locked) {
    return <span className="pill pill-locked">locked</span>;
  }
  return <span className="pill pill-unlocked">unlocked</span>;
}

// ---------------------------------------------------------------------------
// Import view (no wallet provisioned yet)
// ---------------------------------------------------------------------------

function ImportView({ onDone }: { onDone: () => Promise<void> }): React.JSX.Element {
  const [mnemonic, setMnemonic] = useState('');
  const [password, setPassword] = useState('');
  const [useKeychain, setUseKeychain] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // importWallet: main re-derives the seed, encrypts it under an Argon2id
      // KEK from `password`, and (optionally) stores that KEK in the OS keychain.
      await wallet.importWallet({ mnemonic: mnemonic.trim(), password, useKeychain });
      await onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card" onSubmit={(e) => void submit(e)}>
      <h2 className="card-title">Import wallet</h2>
      <p className="muted">
        Paste an existing QRL mnemonic. It is sent to the main process once for provisioning and is
        never retained in this renderer.
      </p>

      <label className="field">
        <span className="field-label">Recovery mnemonic</span>
        <textarea
          className="input mono"
          rows={3}
          value={mnemonic}
          onChange={(e) => setMnemonic(e.target.value)}
          placeholder="word1 word2 word3 ..."
          autoComplete="off"
          spellCheck={false}
          required
        />
      </label>

      <label className="field">
        <span className="field-label">Password</span>
        <input
          className="input"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          required
        />
      </label>

      <label className="check">
        <input
          type="checkbox"
          checked={useKeychain}
          onChange={(e) => setUseKeychain(e.target.checked)}
        />
        <span>Store KEK in OS keychain (macOS Touch ID / passcode)</span>
      </label>

      {error !== null && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}

      <button className="btn btn-primary" type="submit" disabled={busy}>
        {busy ? 'Importing.' : 'Import wallet'}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Unlock view (wallet exists, session locked)
// ---------------------------------------------------------------------------

function UnlockView({ onDone }: { onDone: () => Promise<void> }): React.JSX.Element {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Unlock with an explicit password.
  const unlockWithPassword = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await wallet.unlock({ password });
      await onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  // Unlock via the OS keychain: omit `password` entirely. Main retrieves the
  // KEK behind a Touch ID / passcode prompt (macOS) and opens the session.
  const unlockWithKeychain = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await wallet.unlock({});
      await onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card" onSubmit={(e) => void unlockWithPassword(e)}>
      <h2 className="card-title">Unlock</h2>
      <p className="muted">Enter your password, or unlock with the OS keychain.</p>

      <label className="field">
        <span className="field-label">Password</span>
        <input
          className="input"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          autoFocus
          required
        />
      </label>

      {error !== null && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}

      <div className="btn-row">
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? 'Unlocking.' : 'Unlock'}
        </button>
        <button
          className="btn btn-ghost"
          type="button"
          disabled={busy}
          onClick={() => void unlockWithKeychain()}
        >
          Unlock with Touch ID / keychain
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Unlocked view (active session)
// ---------------------------------------------------------------------------

function UnlockedView({
  status,
  onDone,
}: {
  status: WalletStatus;
  onDone: () => Promise<void>;
}): React.JSX.Element {
  const [error, setError] = useState<string | null>(null);

  const lock = async (): Promise<void> => {
    setError(null);
    try {
      await wallet.lock();
      await onDone();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <div className="stack">
      <section className="card">
        <h2 className="card-title">Session</h2>
        <div className="kv">
          <span className="kv-key">Active address</span>
          <span className="kv-val mono">{status.address ?? '(none)'}</span>
        </div>
        <div className="kv">
          <span className="kv-key">KEK backing</span>
          <span className="kv-val">{status.keychainBacked ? 'OS keychain' : 'password only'}</span>
        </div>
        <Countdown expiresAt={status.unlockExpiresAt} />
        {error !== null && (
          <div className="banner banner-error" role="alert">
            {error}
          </div>
        )}
        <button className="btn btn-ghost" type="button" onClick={() => void lock()}>
          Lock now
        </button>
      </section>

      <BalancePanel defaultAddress={status.address ?? ''} />

      {status.address !== null && <SendPanel from={status.address} />}

      <SignMessagePanel />
    </div>
  );
}

/** Live auto-lock countdown driven by `unlockExpiresAt` (epoch ms). */
function Countdown({ expiresAt }: { expiresAt: number | null }): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (expiresAt === null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  if (expiresAt === null) {
    return (
      <div className="kv">
        <span className="kv-key">Auto-lock</span>
        <span className="kv-val">n/a</span>
      </div>
    );
  }

  return (
    <div className="kv">
      <span className="kv-key">Auto-lock in</span>
      <span className="kv-val mono">{formatRemaining(expiresAt - now)}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Balance panel
// ---------------------------------------------------------------------------

function BalancePanel({ defaultAddress }: { defaultAddress: string }): React.JSX.Element {
  const [address, setAddress] = useState(defaultAddress);
  const [result, setResult] = useState<BalanceResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchBalance = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      // getBalance is the read-only path: no unlock required, no signing.
      const r = await wallet.getBalance({ address });
      setResult(r);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card" onSubmit={(e) => void fetchBalance(e)}>
      <h2 className="card-title">Balance</h2>
      <label className="field">
        <span className="field-label">Address</span>
        <input
          className="input mono"
          type="text"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="Q..."
          autoComplete="off"
          spellCheck={false}
          required
        />
      </label>

      {error !== null && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}

      {result !== null && (
        <div className="banner banner-ok">
          <span className="mono">{result.balance}</span> (smallest unit)
        </div>
      )}

      <button className="btn btn-primary" type="submit" disabled={busy}>
        {busy ? 'Querying.' : 'Get balance'}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Send panel: buildTransaction -> requestSignature -> sendRawTransaction
// ---------------------------------------------------------------------------

interface SendStep {
  label: string;
  detail: string;
}

function SendPanel({ from }: { from: string }): React.JSX.Element {
  const [to, setTo] = useState('');
  const [value, setValue] = useState('');
  const [feeLevel, setFeeLevel] = useState<FeeLevel>('medium');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [steps, setSteps] = useState<SendStep[]>([]);
  const [txHash, setTxHash] = useState<string | null>(null);

  const pushStep = (label: string, detail: string): void => {
    setSteps((prev) => [...prev, { label, detail }]);
  };

  const send = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSteps([]);
    setTxHash(null);
    try {
      // Step 1: assemble the unsigned EIP-1559 type-2 transaction. Main fills
      // nonce / gas / fee caps / chainId from the RPC.
      const unsigned: UnsignedTransaction = await wallet.buildTransaction({
        from,
        to,
        value,
        feeLevel,
      });
      pushStep(
        'Built unsigned tx',
        `nonce=${String(unsigned.nonce)} gas=${unsigned.gas} maxFee=${unsigned.maxFeePerGas} maxPrio=${unsigned.maxPriorityFeePerGas} chainId=${String(unsigned.chainId)}`,
      );

      // Step 2: request a signature. The main process draws a NATIVE
      // confirmation dialog (outside this renderer, so a compromised renderer
      // cannot fake or auto-approve it) before the isolated signer signs.
      pushStep(
        'Awaiting confirmation',
        'A native confirmation dialog is shown by the main process. Signing only proceeds if you approve there.',
      );
      const sig: SignatureResult = await wallet.requestSignature({
        kind: 'transaction',
        tx: unsigned,
      });
      const raw = sig.rawTransaction ?? sig.signature;
      pushStep('Signed by signer process', `signer=${sig.signer}`);

      // Step 3: broadcast the signed raw transaction via the RPC proxy.
      const { transactionHash } = await wallet.sendRawTransaction({ rawTx: raw });
      pushStep('Broadcast', transactionHash);
      setTxHash(transactionHash);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card" onSubmit={(e) => void send(e)}>
      <h2 className="card-title">Send</h2>
      <p className="muted">
        Three steps: build, sign (with a native confirmation dialog drawn by main), then broadcast.
      </p>

      <label className="field">
        <span className="field-label">To</span>
        <input
          className="input mono"
          type="text"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="Q..."
          autoComplete="off"
          spellCheck={false}
          required
        />
      </label>

      <div className="field-grid">
        <label className="field">
          <span className="field-label">Amount (smallest unit)</span>
          <input
            className="input mono"
            type="text"
            inputMode="numeric"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="1000000000000000000"
            autoComplete="off"
            required
          />
        </label>

        <label className="field">
          <span className="field-label">Fee level</span>
          <select
            className="input"
            value={feeLevel}
            onChange={(e) => setFeeLevel(e.target.value as FeeLevel)}
          >
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
          </select>
        </label>
      </div>

      {steps.length > 0 && (
        <ol className="steps">
          {steps.map((s, i) => (
            <li key={i} className="step">
              <span className="step-label">{s.label}</span>
              <span className="step-detail mono">{s.detail}</span>
            </li>
          ))}
        </ol>
      )}

      {error !== null && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}

      {txHash !== null && (
        <div className="banner banner-ok">
          Broadcast tx hash: <span className="mono">{txHash}</span>
        </div>
      )}

      <button className="btn btn-primary" type="submit" disabled={busy}>
        {busy ? 'Working.' : 'Build, sign and send'}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Sign message panel
// ---------------------------------------------------------------------------

function SignMessagePanel(): React.JSX.Element {
  const [messageHex, setMessageHex] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SignatureResult | null>(null);

  const sign = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      // Message signing mirrors the wallet's qrl_signMessage: a native
      // confirmation dialog is shown by main, then the signer produces an
      // ML-DSA-87 signature over the SHAKE256 digest.
      const sig = await wallet.requestSignature({ kind: 'message', messageHex });
      setResult(sig);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card" onSubmit={(e) => void sign(e)}>
      <h2 className="card-title">Sign message</h2>
      <p className="muted">Signs a hex payload (ML-DSA-87 over a SHAKE256 digest).</p>

      <label className="field">
        <span className="field-label">Message (hex)</span>
        <input
          className="input mono"
          type="text"
          value={messageHex}
          onChange={(e) => setMessageHex(e.target.value)}
          placeholder="0xdeadbeef"
          autoComplete="off"
          spellCheck={false}
          required
        />
      </label>

      {error !== null && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}

      {result !== null && (
        <div className="result">
          <div className="kv">
            <span className="kv-key">Signer</span>
            <span className="kv-val mono">{result.signer}</span>
          </div>
          {result.digest !== undefined && (
            <div className="kv">
              <span className="kv-key">Digest</span>
              <span className="kv-val mono break">{result.digest}</span>
            </div>
          )}
          <div className="kv">
            <span className="kv-key">Signature</span>
            <span className="kv-val mono break">{result.signature}</span>
          </div>
          {result.publicKey !== undefined && (
            <div className="kv">
              <span className="kv-key">Public key</span>
              <span className="kv-val mono break">{result.publicKey}</span>
            </div>
          )}
        </div>
      )}

      <button className="btn btn-primary" type="submit" disabled={busy}>
        {busy ? 'Signing.' : 'Sign message'}
      </button>
    </form>
  );
}
