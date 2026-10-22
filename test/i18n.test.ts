import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { catalogs, translate, minutesLabel, type MessageKey } from '../src/shared/i18n';
import { isLanguage, LANGUAGES, resolveLanguage } from '../src/shared/language';
import { LanguageSchema } from '../src/shared/schemas';
import { readSettingsFile, updateSettingsFile } from '../src/main/settingsFile';

const keys = Object.keys(catalogs.en).filter((key): key is MessageKey =>
  Object.hasOwn(catalogs.en, key),
);
const placeholders = (text: string) =>
  [...text.matchAll(/\{\{(\w+)\}\}/gu)].map((m) => m[1]).sort();

test('language detection follows preference order, regional variants and Simplified Chinese', () => {
  for (const [tags, expected] of [
    [['de-DE'], 'de'],
    [['es-MX'], 'es'],
    [['ru_RU'], 'ru'],
    [['zh-CN'], 'zh-CN'],
    [['zh-Hans-CN'], 'zh-CN'],
    [['zh-SG'], 'zh-CN'],
    [['zh'], 'en'],
    [['zh-TW'], 'en'],
    [['zh-Hant-CN'], 'en'],
    [['fr-FR', 'ru-RU', 'en-US'], 'ru'],
    [['en-GB', 'de'], 'en'],
    [['unknown'], 'en'],
    [['english'], 'en'],
  ] as const)
    assert.equal(resolveLanguage(tags), expected);
  assert.equal(resolveLanguage([], 'de-AT'), 'de');
  assert.equal(resolveLanguage([]), 'en');
});

for (const language of LANGUAGES) {
  test(`${language}: exact catalog keys, placeholders, security terms and writing rules`, () => {
    assert.deepEqual(Object.keys(catalogs[language]).sort(), [...keys].sort());
    for (const key of keys) {
      const source = catalogs.en[key];
      const target = catalogs[language][key];
      assert.ok(target.trim(), key);
      assert.deepEqual(placeholders(target), placeholders(source), key);
      assert.doesNotMatch(target.replaceAll('\n', ''), /[\u2014\p{Cc}\p{Cf}]/u, key);
      for (const term of ['Quanta', 'MyQRLWallet', 'QRL', 'QRL 2.0']) {
        assert.equal(target.split(term).length, source.split(term).length, `${key}: ${term}`);
      }
      const values = Object.fromEntries(
        placeholders(source).map((name) => [String(name), '{{verbatim}} $& Qabcdef 0.000001']),
      );
      assert.ok(!translate(language, key, values).includes('undefined'));
      if (placeholders(source).length)
        assert.ok(translate(language, key, values).includes('{{verbatim}} $& Qabcdef 0.000001'));
    }
    if (language === 'en') {
      for (const text of Object.values(catalogs.en))
        assert.doesNotMatch(text, /rather than|instead of|, not /iu);
    }
  });
}

test('strict wire language codes accept only the five static catalogs', () => {
  for (const language of LANGUAGES) assert.equal(LanguageSchema.parse(language), language);
  for (const value of [
    'DE',
    'de-DE',
    'zh',
    'zh-TW',
    '',
    '../de',
    'constructor',
    '<b>de</b>',
    null,
    undefined,
    1,
    {},
    ['de'],
    { language: 'de', label: 'Approve' },
  ]) {
    assert.equal(isLanguage(value), false);
    assert.equal(LanguageSchema.safeParse(value).success, false);
  }
});

test('Russian minute counts use one, few and many; other languages keep complete phrases', () => {
  assert.equal(minutesLabel('ru', 1), '1 минута');
  assert.equal(minutesLabel('ru', 2), '2 минуты');
  assert.equal(minutesLabel('ru', 5), '5 минут');
  assert.equal(minutesLabel('ru', 21), '21 минута');
  assert.equal(minutesLabel('de', 60), '60 Minuten');
  assert.equal(minutesLabel('zh-CN', 1), '1 分钟');
});

test('language and simultaneous native security updates persist without lost fields', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'qrl-i18n-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json');
  await Promise.all([
    updateSettingsFile(file, { language: 'de' }),
    updateSettingsFile(file, { autolockMs: 900_000 }),
    updateSettingsFile(file, { language: 'zh-CN' }),
    updateSettingsFile(file, { biometricUnlock: false }),
  ]);
  assert.deepEqual(await readSettingsFile(file), {
    v: 1,
    language: 'zh-CN',
    autolockMs: 900_000,
    biometricUnlock: false,
  });
});
