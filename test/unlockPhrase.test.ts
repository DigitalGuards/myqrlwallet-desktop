import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { UnlockPhraseSchema } from '../src/shared/schemas';
import { generateUnlockPhrase } from '../src/main/unlockPhrase';
import {
  readSettingsFile,
  unlockPhraseForFile,
  updateSettingsFile,
  writeSettingsFile,
} from '../src/main/settingsFile';

test('personal phrases enforce visible text and UTF-16 bounds', () => {
  for (const value of [
    'abc',
    'blue river-7',
    'Grüne Wiese',
    'luna cálida',
    'Тихая река',
    '蓝色河流',
    '𐐀'.repeat(32),
    'W'.repeat(64),
  ]) {
    assert.equal(UnlockPhraseSchema.safeParse(value).success, true, value);
  }
  for (const value of [
    '',
    'ab',
    'W'.repeat(65),
    '𐐀'.repeat(33),
    ' blue',
    'blue ',
    'blue  river',
    '-blue',
    'blue--river',
    '<b>blue</b>',
    'a\nb',
    'a\tb',
    'a\0b',
    'ab\u202ecd',
    'ab\u2066cd',
    'ab\u200bcd',
    'ab\u3164cd',
    'ab\u00a0cd',
    'ab\ud800cd',
    'ab\u2028cd',
    'ab😀cd',
    123,
    null,
  ]) {
    assert.equal(UnlockPhraseSchema.safeParse(value).success, false, String(value));
  }
});

test('generated marks have four words and satisfy the persisted schema', () => {
  for (let i = 0; i < 128; i++) {
    const phrase = generateUnlockPhrase();
    assert.match(phrase, /^[a-z]+(?: [a-z]+){3}$/u);
    assert.equal(UnlockPhraseSchema.parse(phrase), phrase);
  }
});

test('1.4.4 migration, concurrent first reads, rotation and preference updates preserve every field', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'personal-phrase-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'settings.json');
  const old = {
    v: 1,
    autolockMs: 900_000,
    biometricUnlock: false,
    language: 'de',
    legacyNoticeAckV1: true,
  } as const;
  await writeFile(file, JSON.stringify(old));
  assert.deepEqual(await readSettingsFile(file), old);
  const [first, second] = await Promise.all([
    unlockPhraseForFile(file),
    unlockPhraseForFile(file),
    updateSettingsFile(file, { language: 'ru' }),
  ]);
  assert.equal(first, second);
  assert.deepEqual(await readSettingsFile(file), { ...old, language: 'ru', unlockPhrase: first });
  assert.equal(await unlockPhraseForFile(file), first, 'mark survives subsequent reads');
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  const next = await unlockPhraseForFile(file, true);
  assert.notEqual(next, first);
  assert.deepEqual(await readSettingsFile(file), { ...old, language: 'ru', unlockPhrase: next });
  await Promise.all([
    updateSettingsFile(file, { unlockPhrase: 'My personal river' }),
    updateSettingsFile(file, { autolockMs: 60_000 }),
    updateSettingsFile(file, { biometricUnlock: true }),
  ]);
  assert.equal(await unlockPhraseForFile(file), 'My personal river');
  assert.deepEqual(await readSettingsFile(file), {
    ...old,
    language: 'ru',
    autolockMs: 60_000,
    biometricUnlock: true,
    unlockPhrase: 'My personal river',
  });
  const before = await readFile(file, 'utf8');
  await assert.rejects(updateSettingsFile(file, { unlockPhrase: '<script>' }));
  assert.equal(await readFile(file, 'utf8'), before);
  await updateSettingsFile(file, { language: 'es' });
  assert.equal(
    await unlockPhraseForFile(file),
    'My personal river',
    'queue recovers after invalid writes',
  );
  await writeFile(file, JSON.stringify({ ...old, unlockPhrase: next, unknown: true }));
  assert.deepEqual(await readSettingsFile(file), { v: 1 }, 'strict envelope rejects unknown keys');
  await writeFile(file, JSON.stringify({ ...old, unlockPhrase: 'x\ny' }));
  assert.deepEqual(
    await readSettingsFile(file),
    { v: 1 },
    'disk content gets the same phrase validation',
  );
});

test('first use requires successful persistence and recovers after an I/O failure', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'personal-phrase-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const blocked = path.join(directory, 'blocked');
  await writeFile(blocked, 'fixture');
  const file = path.join(blocked, 'settings.json');
  await assert.rejects(unlockPhraseForFile(file));
  await rm(blocked);
  const phrase = await unlockPhraseForFile(file);
  assert.equal((await readSettingsFile(file)).unlockPhrase, phrase);
  await writeSettingsFile(file, { v: 1, unlockPhrase: phrase });
  assert.equal(await unlockPhraseForFile(file), phrase);
});
