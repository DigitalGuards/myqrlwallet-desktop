/**
 * Persistence of the desktop settings, modeled on the seed store
 * (src/main/seedFile.ts): atomic replace (mkdir, unique 0600 temp file, fsync,
 * rename) so a crash mid-write can never leave a truncated file, and
 * self-healing reads (any missing / unparsable / wrong-shaped content degrades
 * to defaults, never throws at startup).
 *
 * File: userData/settings.json. Versioned zod-strict envelope
 * `{ v: 1, autolockMs?, biometricUnlock?, language?, legacyNoticeAckV1?, unlockPhrase? }`.
 * The personal mark is private to native surfaces. Same-user malware can read
 * this file, so the mark provides no protection against host compromise.
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
import { LanguageSchema, UnlockPhraseSchema } from '../shared/schemas';
import { generateUnlockPhrase } from './unlockPhrase';
import type { Language } from '../shared/language';
import { DEFAULT_AUTOLOCK_MS } from '../shared/constants';

/** Bounds for a STORED autolock timeout. The env override is not clamped
 * (operator escape hatch, matching the previous QRL_AUTOLOCK_MS behavior). */
export const AUTOLOCK_MIN_MS = 60_000;
export const AUTOLOCK_MAX_MS = 3_600_000;

/** Versioned on-disk envelope. Strict: an extra/unknown key marks the file
 * corrupt (self-heals to defaults) rather than silently carrying junk. */
const StoredSettingsSchema = z.strictObject({
  v: z.literal(1),
  language: LanguageSchema.optional(),
  unlockPhrase: UnlockPhraseSchema.optional(),
  autolockMs: z.number().int().optional(),
  biometricUnlock: z.boolean().optional(),
  /** The one-time v3 storage notice has been shown and dismissed. */
  legacyNoticeAckV1: z.boolean().optional(),
});

export type StoredSettings = z.infer<typeof StoredSettingsSchema>;

/** Main-owned settings store patch. Native security settings use a separate IPC schema. */
export interface SettingsPatch {
  unlockPhrase?: string | undefined;
  language?: Language | undefined;
  autolockMs?: number | undefined;
  biometricUnlock?: boolean | undefined;
  legacyNoticeAckV1?: boolean | undefined;
}

export const SETTINGS_DEFAULTS: StoredSettings = { v: 1 };

export function clampAutolockMs(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULT_AUTOLOCK_MS;
  return Math.min(AUTOLOCK_MAX_MS, Math.max(AUTOLOCK_MIN_MS, Math.trunc(ms)));
}

/** Normalise a parsed envelope: clamp the stored autolock into bounds. */
function normalise(s: StoredSettings): StoredSettings {
  const out: StoredSettings = { v: 1 };
  if (s.language !== undefined) out.language = s.language;
  if (s.unlockPhrase !== undefined) out.unlockPhrase = s.unlockPhrase;
  if (s.autolockMs !== undefined) out.autolockMs = clampAutolockMs(s.autolockMs);
  if (s.biometricUnlock !== undefined) out.biometricUnlock = s.biometricUnlock;
  if (s.legacyNoticeAckV1 !== undefined) out.legacyNoticeAckV1 = s.legacyNoticeAckV1;
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
type SettingsChange = SettingsPatch | ((current: StoredSettings) => SettingsPatch);

async function mergeSettingsFile(
  filePath: string,
  change: SettingsChange,
): Promise<StoredSettings> {
  const current = await readSettingsFile(filePath);
  const patch = typeof change === 'function' ? change(current) : change;
  if (Object.keys(patch).length === 0) return current;
  const next: StoredSettings = { ...current };
  if (patch.unlockPhrase !== undefined) next.unlockPhrase = patch.unlockPhrase;
  if (patch.language !== undefined) next.language = patch.language;
  if (patch.autolockMs !== undefined) next.autolockMs = patch.autolockMs;
  if (patch.biometricUnlock !== undefined) next.biometricUnlock = patch.biometricUnlock;
  if (patch.legacyNoticeAckV1 !== undefined) next.legacyNoticeAckV1 = patch.legacyNoticeAckV1;
  const validated = normalise(StoredSettingsSchema.parse(next));
  await atomicWrite(filePath, JSON.stringify(validated, null, 2));
  return validated;
}

// Each file has its own write queue; failed writes leave later updates usable.
const updates = new Map<string, Promise<StoredSettings>>();
function queueSettingsChange(filePath: string, change: SettingsChange): Promise<StoredSettings> {
  const previous = updates.get(filePath) ?? Promise.resolve(SETTINGS_DEFAULTS);
  const result = previous
    .catch(() => SETTINGS_DEFAULTS)
    .then(() => mergeSettingsFile(filePath, change));
  updates.set(filePath, result);
  void result
    .finally(() => {
      if (updates.get(filePath) === result) updates.delete(filePath);
    })
    .catch(() => undefined);
  return result;
}

export function updateSettingsFile(
  filePath: string,
  patch: SettingsPatch,
): Promise<StoredSettings> {
  return queueSettingsChange(filePath, patch);
}

/** Creation and rotation share the preference-write queue. Return only after
 * persistence succeeds, so concurrent native reads see the same saved mark. */
export async function unlockPhraseForFile(filePath: string, renew = false): Promise<string> {
  const stored = await queueSettingsChange(filePath, (current) => {
    if (current.unlockPhrase !== undefined && !renew) return {};
    let unlockPhrase: string;
    do {
      unlockPhrase = generateUnlockPhrase();
    } while (unlockPhrase === current.unlockPhrase);
    return { unlockPhrase };
  });
  if (stored.unlockPhrase === undefined) throw new Error('personal phrase unavailable');
  return stored.unlockPhrase;
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

/** Only the native unlock and settings IPC may return this value. */
export async function getUnlockPhrase(renew = false): Promise<string> {
  return unlockPhraseForFile(await settingsPath(), renew);
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
 * settings panel (stored `true`, not the undefined default). Gates KEK
 * re-provisioning on a password unlock: the toggle-off sweep deletes stored
 * KEKs and import-time provisioning alone could never restore them, but a
 * password unlock must not push the KEK into the OS vault for users who never
 * opted in via settings (their import-time choice stands). */
export async function isBiometricUnlockExplicitlyEnabled(): Promise<boolean> {
  const stored = await readSettings();
  return stored.biometricUnlock === true;
}
