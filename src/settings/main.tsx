import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './settings.css';
import logoUrl from '../unlock/logo.png';

type SettingsAction = 'reregister-protocol' | 'open-logs';

interface DesktopSettings {
  autolockMs: number;
  biometricUnlock: boolean;
}

interface SettingsCapabilities {
  biometricsAvailable: boolean;
  platform: string;
  appVersion: string;
  autolockEnvOverride: boolean;
  effectiveAutolockMs: number;
}

interface SettingsWalletInfo {
  activeAddress: string | null;
}

interface SettingsBridge {
  get(): Promise<{
    settings: DesktopSettings;
    wallet: SettingsWalletInfo;
    capabilities: SettingsCapabilities;
  }>;
  set(patch: Partial<DesktopSettings>): Promise<{ settings: DesktopSettings }>;
  action(action: SettingsAction): Promise<{ ok: boolean; error?: string }>;
  removeWallet(): Promise<{ activeAddress: string | null }>;
}

declare global {
  interface Window {
    settingsBridge: SettingsBridge;
  }
}

/** Bounded choice list for the auto-lock timeout (minutes). */
const AUTOLOCK_MINUTES = [1, 5, 15, 30, 60];

function minutesLabel(minutes: number): string {
  return minutes === 1 ? '1 minute' : `${String(minutes)} minutes`;
}

interface ActionState {
  ok: boolean;
  message: string;
}

function SettingsApp() {
  const [settings, setSettings] = useState<DesktopSettings | null>(null);
  const [wallet, setWallet] = useState<SettingsWalletInfo | null>(null);
  const [caps, setCaps] = useState<SettingsCapabilities | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<ActionState | null>(null);
  const [protocolStatus, setProtocolStatus] = useState<ActionState | null>(null);
  const [logsStatus, setLogsStatus] = useState<ActionState | null>(null);
  const [busyAction, setBusyAction] = useState<SettingsAction | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeStatus, setRemoveStatus] = useState<ActionState | null>(null);

  // The window takes over the wallet's bounds, so give it the native-screen
  // escape hatch: Esc closes it (main restores the wallet window underneath).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') window.close();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    window.settingsBridge
      .get()
      .then((info) => {
        if (cancelled) return;
        setSettings(info.settings);
        setWallet(info.wallet);
        setCaps(info.capabilities);
      })
      .catch(() => {
        if (!cancelled) setSaveStatus({ ok: false, message: 'Failed to load settings.' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function apply(patch: Partial<DesktopSettings>) {
    if (saving) return;
    setSaving(true);
    setSaveStatus(null);
    try {
      const result = await window.settingsBridge.set(patch);
      setSettings(result.settings);
      setSaveStatus({ ok: true, message: 'Saved.' });
    } catch {
      setSaveStatus({ ok: false, message: 'Could not save. Please try again.' });
    } finally {
      setSaving(false);
    }
  }

  async function removeAccount() {
    if (removing) return;
    setRemoving(true);
    setRemoveStatus(null);
    try {
      // Main draws the trusted confirmation (default Cancel) over this window
      // before anything is deleted; this button only starts that flow.
      const result = await window.settingsBridge.removeWallet();
      setWallet({ activeAddress: result.activeAddress });
      setRemoveStatus({ ok: true, message: 'Account removed from this device.' });
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      // Trusted dialog cancelled: silently abort, no error banner.
      if (!/reject|cancel/i.test(message)) {
        setRemoveStatus({ ok: false, message: 'Could not remove the account.' });
      }
    } finally {
      setRemoving(false);
    }
  }

  async function runAction(action: SettingsAction, report: (s: ActionState | null) => void) {
    if (busyAction) return;
    setBusyAction(action);
    report(null);
    try {
      const result = await window.settingsBridge.action(action);
      report(
        result.ok
          ? { ok: true, message: 'Done.' }
          : { ok: false, message: result.error ?? 'Failed.' },
      );
    } catch {
      report({ ok: false, message: 'Failed.' });
    } finally {
      setBusyAction(null);
    }
  }

  const loading = !settings || !caps;
  const autolockMinutes = settings ? Math.round(settings.autolockMs / 60_000) : 5;
  const knownChoice = AUTOLOCK_MINUTES.includes(autolockMinutes);
  const envMinutes = caps ? Math.max(1, Math.round(caps.effectiveAutolockMs / 60_000)) : 0;

  return (
    <div className="settings-root">
      <header className="settings-header">
        <img className="settings-logo" src={logoUrl} alt="" aria-hidden="true" />
        <h1 className="settings-title">Settings</h1>
        <button
          className="settings-button settings-close"
          type="button"
          onClick={() => window.close()}
        >
          Back to wallet
        </button>
      </header>

      {loading ? (
        <div className="settings-body">
          <p className="settings-help">Loading...</p>
          {saveStatus && !saveStatus.ok && (
            <p className="settings-status error">{saveStatus.message}</p>
          )}
        </div>
      ) : (
        <div className="settings-body">
          <section className="settings-card">
            <div className="settings-row">
              <span className="settings-label">Auto-lock timeout</span>
              <select
                className="settings-select"
                aria-label="Auto-lock timeout"
                value={autolockMinutes}
                disabled={saving || caps.autolockEnvOverride}
                onChange={(event) =>
                  void apply({ autolockMs: Number(event.target.value) * 60_000 })
                }
              >
                {!knownChoice && (
                  <option value={autolockMinutes} disabled>
                    {minutesLabel(autolockMinutes)}
                  </option>
                )}
                {AUTOLOCK_MINUTES.map((m) => (
                  <option key={m} value={m}>
                    {minutesLabel(m)}
                  </option>
                ))}
              </select>
            </div>
            <p className="settings-help">
              The wallet locks and requires your password again after this long without activity.
            </p>
            {caps.autolockEnvOverride && (
              <p className="settings-note">
                Overridden by the QRL_AUTOLOCK_MS environment variable (currently about{' '}
                {minutesLabel(envMinutes)}). Unset it to manage the timeout here.
              </p>
            )}
          </section>

          {caps.biometricsAvailable && (
            <section className="settings-card">
              <div className="settings-row">
                <span className="settings-label">Biometric quick unlock</span>
                <label className="settings-toggle">
                  <input
                    type="checkbox"
                    aria-label="Biometric quick unlock"
                    checked={settings.biometricUnlock}
                    disabled={saving}
                    onChange={(event) => void apply({ biometricUnlock: event.target.checked })}
                  />
                  <span className="settings-toggle-track" />
                </label>
              </div>
              <p className="settings-help">
                Unlock with your device instead of typing the password. Turning this off removes the
                stored unlock key; turning it on takes effect at your next password unlock.
              </p>
            </section>
          )}

          <section className="settings-card">
            <div className="settings-row">
              <span className="settings-label">qrlconnect:// links</span>
              <button
                className="settings-button"
                type="button"
                disabled={busyAction !== null}
                onClick={() => void runAction('reregister-protocol', setProtocolStatus)}
              >
                Re-register handler
              </button>
            </div>
            <p className="settings-help">
              Make this app the handler for qrlconnect:// dApp links again if another application
              took them over.
            </p>
            {protocolStatus && (
              <p className={`settings-status ${protocolStatus.ok ? 'ok' : 'error'}`}>
                {protocolStatus.message}
              </p>
            )}
          </section>

          <section className="settings-card">
            <div className="settings-row">
              <span className="settings-label">Diagnostics</span>
              <button
                className="settings-button"
                type="button"
                disabled={busyAction !== null}
                onClick={() => void runAction('open-logs', setLogsStatus)}
              >
                Open logs folder
              </button>
            </div>
            <p className="settings-help">
              Logs contain decisions only, never keys, passwords, or addresses in full.
            </p>
            {logsStatus && (
              <p className={`settings-status ${logsStatus.ok ? 'ok' : 'error'}`}>
                {logsStatus.message}
              </p>
            )}
          </section>

          {wallet?.activeAddress && (
            <section className="settings-card danger">
              <div className="settings-row">
                <span className="settings-label">Remove account</span>
                <button
                  className="settings-button danger"
                  type="button"
                  disabled={removing}
                  onClick={() => void removeAccount()}
                >
                  {removing ? 'Removing...' : 'Remove from this device'}
                </button>
              </div>
              <p className="settings-help">
                Permanently deletes the active account&apos;s encrypted seed from this device. You
                will need the recovery phrase (or hex seed) to restore it. Other accounts on this
                device are not affected. You will be asked to confirm.
              </p>
              <p className="settings-address">{wallet.activeAddress}</p>
            </section>
          )}

          {/* Outside the address-gated section: after the LAST wallet is
              removed that section unmounts, and this confirmation must
              survive it. */}
          {removeStatus && (
            <p className={`settings-status ${removeStatus.ok ? 'ok' : 'error'}`}>
              {removeStatus.message}
            </p>
          )}

          {saveStatus && (
            <p className={`settings-status ${saveStatus.ok ? 'ok' : 'error'}`}>
              {saveStatus.message}
            </p>
          )}
        </div>
      )}

      <footer className="settings-footer">MyQRLWallet {caps ? `v${caps.appVersion}` : ''}</footer>
    </div>
  );
}

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <SettingsApp />
    </StrictMode>,
  );
}
