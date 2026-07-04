/**
 * Persistence of the desktop settings, modeled on the seed store
 * (src/main/seedFile.ts): atomic replace (mkdir, unique 0600 temp file, fsync,
 * rename) so a crash mid-write can never leave a truncated file, and
 * self-healing reads (any missing / unparsable / wrong-shaped content degrades
 * to defaults, never throws at startup).
 *
 * File: userData/settings.json. Versioned zod-strict envelope
 * `{ v: 1, autolockMs?, biometricUnlock? }`. NO SECRETS, EVER: same-user
 * malware can read this file; the worst it learns is a timeout preference.
 *
 * Autolock resolution order (getEffectiveAutolockMs):
 *   env QRL_AUTOLOCK_MS (explicit operator override, pre-existing behavior)
 *   > settings store (clamped to [AUTOLOCK_MIN_MS, AUTOLOCK_MAX_MS])
 *   > DEFAULT_AUTOLOCK_MS.
 *
 * The pure helpers below take an explicit file path so they run under
 * `node --test` without the Electron runtime; the thin app-bound wrappers
 * resolve userData via a lazy `import('electron')` (a top-level electron
 * import would break the plain-Node test context, see permissions.ts).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { DEFAULT_AUTOLOCK_MS } from '../shared/constants';

/** Bounds for a STORED autolock timeout. The env override is not clamped
 * (operator escape hatch, matching the previous QRL_AUTOLOCK_MS behavior). */
export const AUTOLOCK_MIN_MS = 60_000;
export const AUTOLOCK_MAX_MS = 3_600_000;

/** Versioned on-disk envelope. Strict: an extra/unknown key marks the file
 * corrupt (self-heals to defaults) rather than silently carrying junk. */
const StoredSettingsSchema = z.strictObject({
  v: z.literal(1),
  autolockMs: z.number().int().optional(),
  biometricUnlock: z.boolean().optional(),
});

export type StoredSettings = z.infer<typeof StoredSettingsSchema>;

/** The renderer-of-the-settings-window facing patch shape (both optional). */
export interface SettingsPatch {
  autolockMs?: number;
  biometricUnlock?: boolean;
}

export const SETTINGS_DEFAULTS: StoredSettings = { v: 1 };

export function clampAutolockMs(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULT_AUTOLOCK_MS;
  return Math.min(AUTOLOCK_MAX_MS, Math.max(AUTOLOCK_MIN_MS, Math.trunc(ms)));
}

/** Normalise a parsed envelope: clamp the stored autolock into bounds. */
function normalise(s: StoredSettings): StoredSettings {
  const out: StoredSettings = { v: 1 };
  if (s.autolockMs !== undefined) out.autolockMs = clampAutolockMs(s.autolockMs);
  if (s.biometricUnlock !== undefined) out.biometricUnlock = s.biometricUnlock;
  return out;
}

/**
 * Autolock resolution order: a valid env override wins, else the stored value
 * (clamped), else the default. An unset/blank/non-numeric/non-positive env
 * value falls through rather than producing a NaN timer.
 */
export function resolveAutolockMs(
  envValue: string | undefined,
  storedMs: number | undefined,
): number {
  if (envValue !== undefined && envValue !== '') {
    const n = Number(envValue);
    if (Number.isFinite(n) && n > 0) return n;
  }
  if (storedMs !== undefined) return clampAutolockMs(storedMs);
  return DEFAULT_AUTOLOCK_MS;
}

/** True when QRL_AUTOLOCK_MS is set to a usable value (the store is bypassed). */
export function hasAutolockEnvOverride(envValue: string | undefined): boolean {
  if (envValue === undefined || envValue === '') return false;
  const n = Number(envValue);
  return Number.isFinite(n) && n > 0;
}

// Monotonic per-process sequence for unique temp-file names (see seedFile.ts).
let tmpSeq = 0;

/** Atomic replace: write + fsync a 0600 temp file, then rename over target. */
async function atomicWrite(p: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${tmpSeq++}.tmp`;
  const handle = await fs.open(tmp, 'w', 0o600); // 0600: owner read/write only
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } catch (err) {
    // Failed mid-write: close and remove the temp file (best-effort) so a
    // throw does not orphan `settings.json.<pid>.<seq>.tmp` next to the store.
    await handle.close().catch(() => undefined);
    await fs.unlink(tmp).catch(() => undefined);
    throw err;
  }
  await handle.close();
  try {
    await fs.rename(tmp, p);
  } catch (err) {
    await fs.unlink(tmp).catch(() => undefined);
    throw err;
  }
}

/**
 * Read the settings file at `filePath`. Self-healing and non-throwing: a
 * missing, unreadable, unparsable, wrong-versioned, or extra-keyed file
 * degrades to defaults so a corrupt settings file can never break startup.
 */
export async function readSettingsFile(filePath: string): Promise<StoredSettings> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    return { ...SETTINGS_DEFAULTS };
  }
  try {
    const parsed = StoredSettingsSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return { ...SETTINGS_DEFAULTS };
    return normalise(parsed.data);
  } catch {
    return { ...SETTINGS_DEFAULTS };
  }
}

/** Validate + clamp, then atomically persist the full envelope. */
export async function writeSettingsFile(filePath: string, next: StoredSettings): Promise<void> {
  const validated = normalise(StoredSettingsSchema.parse(next));
  await atomicWrite(filePath, JSON.stringify(validated, null, 2));
}

/** Read-merge-write a partial update; returns the stored result. Undefined
 * patch fields leave the existing values untouched. */
export async function updateSettingsFile(
  filePath: string,
  patch: SettingsPatch,
): Promise<StoredSettings> {
  const current = await readSettingsFile(filePath);
  const next: StoredSettings = { ...current };
  if (patch.autolockMs !== undefined) next.autolockMs = patch.autolockMs;
  if (patch.biometricUnlock !== undefined) next.biometricUnlock = patch.biometricUnlock;
  const validated = normalise(next);
  await atomicWrite(filePath, JSON.stringify(validated, null, 2));
  return validated;
}

// ---- app-bound wrappers (Electron main process only) ------------------------

/** Lazy electron import: keeps this module loadable under plain-Node tests. */
async function settingsPath(): Promise<string> {
  const { app } = await import('electron');
  return path.join(app.getPath('userData'), 'settings.json');
}

export async function readSettings(): Promise<StoredSettings> {
  return readSettingsFile(await settingsPath());
}

export async function updateSettings(patch: SettingsPatch): Promise<StoredSettings> {
  return updateSettingsFile(await settingsPath(), patch);
}

/** The autolock bound to pass on every signer.unlock / setAutolock. */
export async function getEffectiveAutolockMs(): Promise<number> {
  const stored = await readSettings();
  return resolveAutolockMs(process.env['QRL_AUTOLOCK_MS'], stored.autolockMs);
}

/** Whether the biometric quick-unlock preference is on (default: on, which
 * preserves the pre-settings behavior of the keychain opt-in at provisioning). */
export async function getBiometricUnlockEnabled(): Promise<boolean> {
  const stored = await readSettings();
  return stored.biometricUnlock ?? true;
}

/** True only when the user EXPLICITLY enabled biometric quick unlock in the
 * settings window (stored `true`, not the undefined default). Gates KEK
 * re-provisioning on a password unlock: the toggle-off sweep deletes stored
 * KEKs and import-time provisioning alone could never restore them, but a
 * password unlock must not push the KEK into the OS vault for users who never
 * opted in via settings (their import-time choice stands). */
export async function isBiometricUnlockExplicitlyEnabled(): Promise<boolean> {
  const stored = await readSettings();
  return stored.biometricUnlock === true;
}
