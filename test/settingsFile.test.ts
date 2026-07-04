/**
 * Settings store behaviour test (src/main/settingsFile.ts): the main-owned
 * userData/settings.json persistence and the autolock resolution order.
 *
 * Verified here:
 *   - write/read round-trip preserves the envelope
 *   - a partial update merges without clobbering the other field
 *   - a missing, corrupt, wrong-versioned, or extra-keyed file self-heals to
 *     defaults (and never throws)
 *   - stored autolockMs is clamped into [AUTOLOCK_MIN_MS, AUTOLOCK_MAX_MS]
 *   - the file is written 0600 (owner read/write only)
 *   - resolveAutolockMs order: env override > store > DEFAULT_AUTOLOCK_MS
 *
 * The pure file helpers take an explicit path, so this runs under
 * `node --test --import tsx` without the Electron runtime.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  AUTOLOCK_MAX_MS,
  AUTOLOCK_MIN_MS,
  clampAutolockMs,
  readSettingsFile,
  resolveAutolockMs,
  updateSettingsFile,
  writeSettingsFile,
} from '../src/main/settingsFile';
import { DEFAULT_AUTOLOCK_MS } from '../src/shared/constants';

async function tmpSettingsPath(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'qrl-settings-'));
  return path.join(dir, 'settings.json');
}

test('write/read round-trip preserves the settings envelope', async () => {
  const file = await tmpSettingsPath();
  await writeSettingsFile(file, { v: 1, autolockMs: 900_000, biometricUnlock: false });
  const read = await readSettingsFile(file);
  assert.deepEqual(read, { v: 1, autolockMs: 900_000, biometricUnlock: false });
});

test('a partial update merges and preserves the untouched field', async () => {
  const file = await tmpSettingsPath();
  await writeSettingsFile(file, { v: 1, autolockMs: 900_000, biometricUnlock: false });
  const updated = await updateSettingsFile(file, { autolockMs: 60_000 });
  assert.deepEqual(updated, { v: 1, autolockMs: 60_000, biometricUnlock: false });
  assert.deepEqual(await readSettingsFile(file), updated, 'the merge must be persisted');
});

test('a missing file reads as defaults without throwing', async () => {
  const file = await tmpSettingsPath(); // never written
  assert.deepEqual(await readSettingsFile(file), { v: 1 });
});

test('corrupt JSON self-heals to defaults and stays writable', async () => {
  const file = await tmpSettingsPath();
  await writeFile(file, '{ not json at all', 'utf8');
  assert.deepEqual(await readSettingsFile(file), { v: 1 }, 'corrupt content must read as defaults');
  // Self-heal: the next write replaces the corrupt file cleanly.
  const updated = await updateSettingsFile(file, { biometricUnlock: true });
  assert.deepEqual(updated, { v: 1, biometricUnlock: true });
  assert.deepEqual(await readSettingsFile(file), updated);
});

test('wrong version and extra keys count as corrupt (strict envelope)', async () => {
  const file = await tmpSettingsPath();
  await writeFile(file, JSON.stringify({ v: 2, autolockMs: 900_000 }), 'utf8');
  assert.deepEqual(await readSettingsFile(file), { v: 1 }, 'unknown version -> defaults');
  await writeFile(file, JSON.stringify({ v: 1, autolockMs: 900_000, extra: true }), 'utf8');
  assert.deepEqual(await readSettingsFile(file), { v: 1 }, 'extra key -> defaults');
  await writeFile(file, JSON.stringify({ v: 1, autolockMs: 'soon' }), 'utf8');
  assert.deepEqual(await readSettingsFile(file), { v: 1 }, 'wrong type -> defaults');
});

test('stored autolockMs is clamped into bounds on read and write', async () => {
  const file = await tmpSettingsPath();
  // A hand-edited file below/above the bounds reads back clamped.
  await writeFile(file, JSON.stringify({ v: 1, autolockMs: 5_000 }), 'utf8');
  assert.equal((await readSettingsFile(file)).autolockMs, AUTOLOCK_MIN_MS);
  await writeFile(file, JSON.stringify({ v: 1, autolockMs: 100_000_000 }), 'utf8');
  assert.equal((await readSettingsFile(file)).autolockMs, AUTOLOCK_MAX_MS);
  // A programmatic update clamps before persisting.
  const updated = await updateSettingsFile(file, { autolockMs: 1 });
  assert.equal(updated.autolockMs, AUTOLOCK_MIN_MS);
  const onDisk = JSON.parse(await readFile(file, 'utf8')) as { autolockMs: number };
  assert.equal(onDisk.autolockMs, AUTOLOCK_MIN_MS, 'the clamped value must be what hits disk');
});

test('clampAutolockMs bounds and non-finite handling', () => {
  assert.equal(clampAutolockMs(AUTOLOCK_MIN_MS), AUTOLOCK_MIN_MS);
  assert.equal(clampAutolockMs(AUTOLOCK_MAX_MS), AUTOLOCK_MAX_MS);
  assert.equal(clampAutolockMs(AUTOLOCK_MIN_MS - 1), AUTOLOCK_MIN_MS);
  assert.equal(clampAutolockMs(AUTOLOCK_MAX_MS + 1), AUTOLOCK_MAX_MS);
  assert.equal(clampAutolockMs(Number.NaN), DEFAULT_AUTOLOCK_MS);
  assert.equal(clampAutolockMs(Number.POSITIVE_INFINITY), DEFAULT_AUTOLOCK_MS);
});

test('the settings file is written 0600', { skip: process.platform === 'win32' }, async () => {
  const file = await tmpSettingsPath();
  await writeSettingsFile(file, { v: 1, autolockMs: 900_000 });
  const mode = (await stat(file)).mode & 0o777;
  assert.equal(mode, 0o600, 'owner read/write only');
});

test('autolock resolution order: env > store > default', () => {
  // A valid env override wins outright (and is deliberately NOT clamped:
  // operator escape hatch, matching the pre-store QRL_AUTOLOCK_MS behavior).
  assert.equal(resolveAutolockMs('120000', 900_000), 120_000);
  assert.equal(resolveAutolockMs('10000', 900_000), 10_000, 'env override is unclamped');
  // No env: the stored value applies, clamped.
  assert.equal(resolveAutolockMs(undefined, 900_000), 900_000);
  assert.equal(resolveAutolockMs('', 900_000), 900_000, 'blank env falls through');
  assert.equal(resolveAutolockMs(undefined, 1), AUTOLOCK_MIN_MS, 'stored value is clamped');
  // Invalid env values fall through to the store rather than yielding NaN.
  assert.equal(resolveAutolockMs('abc', 900_000), 900_000);
  assert.equal(resolveAutolockMs('-5', 900_000), 900_000);
  assert.equal(resolveAutolockMs('0', 900_000), 900_000);
  // Nothing configured: the default.
  assert.equal(resolveAutolockMs(undefined, undefined), DEFAULT_AUTOLOCK_MS);
});
