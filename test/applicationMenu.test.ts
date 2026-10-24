import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';
import { LANGUAGES } from '../src/shared/language';
import { translate } from '../src/shared/i18n';

register(new URL('./ipcLanguageMockLoader.mjs', import.meta.url));
const { applicationMenuTemplate } = await import('../src/main/applicationMenu');
const { applyLanguage } = await import('../src/main/language');

for (const language of LANGUAGES) {
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    test(`${language} ${platform}: origin/dev roles and custom items survive unchanged`, (t) => {
      applyLanguage(language);
      t.after(() => applyLanguage('en'));
      const click = () => undefined;
      const settings = {
        label: translate(language, 'menu.settings'),
        accelerator: 'CmdOrCtrl+,',
        click,
      };
      // Pinned origin/dev template. editMenu includes Paste and Match Style,
      // Delete, Substitutions and Speech; windowMenu keeps all native commands.
      const expected =
        platform === 'darwin'
          ? [
              {
                label: 'MyQRLWallet',
                submenu: [
                  { role: 'about' },
                  { type: 'separator' },
                  settings,
                  { type: 'separator' },
                  { role: 'services' },
                  { type: 'separator' },
                  { role: 'hide' },
                  { role: 'hideOthers' },
                  { role: 'unhide' },
                  { type: 'separator' },
                  { role: 'quit' },
                ],
              },
              { role: 'editMenu' },
              { role: 'windowMenu' },
            ]
          : [
              {
                label: translate(language, 'menu.file'),
                submenu: [settings, { type: 'separator' }, { role: 'quit' }],
              },
            ];
      assert.deepEqual(applicationMenuTemplate(click, platform), expected);
    });
  }
}

test('English biometric help retains the origin/dev text exactly', () => {
  assert.equal(
    translate('en', 'settings.biometricHelp'),
    'Unlock with your device instead of typing the password. Turning this off removes the stored unlock key; turning it on takes effect at your next password unlock.',
  );
});
