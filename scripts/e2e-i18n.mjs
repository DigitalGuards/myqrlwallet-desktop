// Uses the release validation approach: real Electron, isolated Xvfb/profile,
// Playwright for app-owned HTML and xdotool for genuine native message boxes.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { translate } from '../src/shared/i18n.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const frontend = process.env.QRL_FRONTEND_DIR ?? path.join(root, 'out/frontend-source');
const require = createRequire(path.join(frontend, 'package.json'));
const { _electron } = require('playwright');
assert.match(process.env.DISPLAY ?? '', /^:(?!0(?:\.|$))\d+/);
assert.ok(!process.env.WAYLAND_DISPLAY, 'Run with env -u DISPLAY -u WAYLAND_DISPLAY plus Xvfb');
const evidence =
  process.env.QRL_I18N_EVIDENCE ?? (await mkdtemp(path.join(tmpdir(), 'desktop-i18n-e2e-')));
await mkdir(evidence, { recursive: true });
const results = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function poll(fn, description) {
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    const result = await fn();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`Timed out: ${description}`);
}

for (const language of ['de', 'zh-CN']) {
  const t = (key, values) => translate(language, key, values);
  const profile = await mkdtemp(path.join(evidence, `${language}-profile-`));
  const env = {};
  for (const key of ['PATH', 'DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR']) {
    env[key] = path.join(profile, key.toLowerCase());
    await mkdir(env[key], { recursive: true, mode: 0o700 });
  }
  env.LANG = language === 'de' ? 'de_DE.UTF-8' : 'zh_CN.UTF-8';
  env.LANGUAGE = language;
  env.QRL_RPC_URL_SECONDARY = 'none';
  const native = (...args) =>
    execFileSync('xdotool', args, {
      env: { ...env, LC_ALL: 'C.UTF-8' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  const snap = (name) =>
    execFileSync('import', ['-window', 'root', path.join(evidence, `${language}-${name}.png`)], {
      env,
      timeout: 15000,
    });
  let app;
  const result = { language, checks: [], screenshots: [] };
  results.push(result);
  try {
    app = await _electron.launch({
      executablePath: path.join(root, 'node_modules/electron/dist/electron'),
      args: [root, `--lang=${language}`, `--user-data-dir=${path.join(profile, 'user-data')}`],
      cwd: root,
      env,
      timeout: 60000,
    });
    // Keep the native probe offline. Message signing needs no RPC or funded account.
    await app.context().route(/^https?:/, (route) => route.abort());
    const wallet = await app.firstWindow();
    await wallet.waitForFunction(() => Boolean(globalThis.window.qrlWallet));
    const startupMenu = await app.evaluate(({ Menu, app }) => ({
      labels: Menu.getApplicationMenu().items.flatMap(
        (item) => item.submenu?.items.map((child) => child.label) ?? [],
      ),
      preferred: app.getPreferredSystemLanguages(),
      locale: app.getLocale(),
    }));
    assert.ok(startupMenu.labels.includes(t('menu.settings')), JSON.stringify(startupMenu));
    result.checks.push('OS language detection');
    await wallet.evaluate((code) => globalThis.window.qrlWallet.setLanguage(code), language);
    const userData = await app.evaluate(({ app }) => app.getPath('userData'));
    assert.equal(
      JSON.parse(await readFile(path.join(userData, 'settings.json'), 'utf8')).language,
      language,
    );
    await assert.rejects(
      wallet.evaluate(() =>
        globalThis.window.qrlWallet.setLanguage({ language: 'de', label: 'Approve' }),
      ),
      /invalid request/,
    );
    result.checks.push('preload language IPC and persistence');

    // Observe options while still drawing each actual OS-native dialog.
    await app.evaluate(({ dialog }) => {
      globalThis.i18nDialogs = [];
      const show = dialog.showMessageBox.bind(dialog);
      dialog.showMessageBox = (...args) => {
        const options = args.at(-1);
        globalThis.i18nDialogs.push({
          title: options.title,
          message: options.message,
          detail: options.detail,
          buttons: options.buttons,
          defaultId: options.defaultId,
          cancelId: options.cancelId,
        });
        return show(...args);
      };
    });
    // Public deterministic fixture, confined to this temporary profile.
    const password = 'NativeI18nFixture!123';
    const status = await wallet.evaluate(
      (password) =>
        globalThis.window.qrlWallet.importWallet({
          hexSeed: '010000' + '01'.repeat(48),
          password,
          useKeychain: false,
        }),
      password,
    );
    assert.equal(status.locked, false);
    await wallet.evaluate(() => globalThis.window.qrlWallet.lock());
    const unlock = await poll(
      () =>
        app
          .context()
          .pages()
          .find((page) => page.url().includes('/unlock/')),
      'unlock window',
    );
    await unlock.getByPlaceholder(t('unlock.password')).waitFor();
    await unlock.getByPlaceholder(t('unlock.password')).fill('wrong-password');
    await unlock.getByRole('button', { name: t('unlock.submit'), exact: true }).click();
    await unlock.getByText(t('unlock.incorrect'), { exact: true }).waitFor();
    // A live change preserves entered input and translates an already displayed error.
    await wallet.evaluate(() => globalThis.window.qrlWallet.setLanguage('es'));
    await unlock.getByText(translate('es', 'unlock.incorrect'), { exact: true }).waitFor();
    await unlock.getByPlaceholder(translate('es', 'unlock.password')).fill(password);
    await wallet.evaluate((code) => globalThis.window.qrlWallet.setLanguage(code), language);
    await unlock.getByPlaceholder(t('unlock.password')).waitFor();
    assert.equal(await unlock.getByPlaceholder(t('unlock.password')).inputValue(), password);
    await unlock.getByRole('button', { name: t('unlock.show'), exact: true }).click();
    await unlock.getByRole('button', { name: t('unlock.hide'), exact: true }).click();
    snap('unlock');
    result.screenshots.push(`${language}-unlock.png`);
    await unlock.getByRole('button', { name: t('unlock.submit'), exact: true }).click();
    await poll(
      async () => !(await wallet.evaluate(() => globalThis.window.qrlWallet.getStatus())).locked,
      'password unlock',
    );
    await poll(() => unlock.isClosed(), 'unlock window closed');
    result.checks.push('unlock, wrong-password error, live language and input retention');

    await wallet.evaluate(() => globalThis.window.qrlWallet.openDesktopSettings());
    const settings = await poll(
      () =>
        app
          .context()
          .pages()
          .find((page) => page.url().includes('/settings/')),
      'settings view',
    );
    await settings.getByRole('heading', { name: t('settings.title'), exact: true }).waitFor();
    await settings.getByLabel(t('settings.autolock'), { exact: true }).selectOption('15');
    await settings.getByText(t('settings.saved'), { exact: true }).waitFor();
    await wallet.evaluate(() => globalThis.window.qrlWallet.setLanguage('ru'));
    await settings
      .getByRole('heading', { name: translate('ru', 'settings.title'), exact: true })
      .waitFor();
    await settings.getByText(translate('ru', 'settings.saved'), { exact: true }).waitFor();
    await wallet.evaluate((code) => globalThis.window.qrlWallet.setLanguage(code), language);
    await settings.getByRole('heading', { name: t('settings.title'), exact: true }).waitFor();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(720, 560));
    await settings.waitForFunction(() => globalThis.innerWidth <= 720);
    const overflow = await settings.evaluate(() =>
      [...globalThis.document.querySelectorAll('button, select, .settings-label')]
        .filter((element) => element.scrollWidth > element.clientWidth + 1)
        .map((element) => element.textContent),
    );
    assert.deepEqual(overflow, []);
    snap('settings');
    result.screenshots.push(`${language}-settings.png`);
    await settings.getByRole('button', { name: t('settings.back'), exact: true }).click();
    result.checks.push('settings save, live status translation, no clipped controls at 720 x 560');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 800));

    const startRequest = async (body) => {
      await wallet.evaluate(
        ({ signer, body }) => {
          globalThis.i18nResult = null;
          const bytes = new TextEncoder().encode(body);
          const messageHex =
            '0x' + [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
          void globalThis.window.qrlWallet
            .requestSignature({
              kind: 'message',
              signer,
              messageHex,
              origin: {
                via: 'dapp',
                name: 'Fixture {{name}}',
                url: 'https://dapp.example/',
                channelId: '12345678-abcd-1234-abcd-123456789012',
              },
            })
            .then(
              (value) => {
                globalThis.i18nResult = { ok: true, signer: value.signer };
              },
              (error) => {
                globalThis.i18nResult = { ok: false, error: error.message };
              },
            );
        },
        { signer: status.address, body },
      );
    };
    const nativeWindow = async () =>
      poll(() => {
        // X11 title matching is encoding-dependent. Identify the real modal by
        // the app's PID and its OS dialog type, then assert its static text below.
        try {
          return native('search', '--onlyvisible', '--pid', String(app.process().pid))
            .split('\n')
            .find((id) => {
              const properties = execFileSync('xprop', ['-id', id, '_NET_WM_WINDOW_TYPE'], {
                env,
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
              });
              return properties.includes('_NET_WM_WINDOW_TYPE_DIALOG');
            });
        } catch {
          return null;
        }
      }, 'native confirmation');
    await startRequest('Review this message. Prüfen. 请审核。 {{name}}');
    const id = await nativeWindow();
    const options = await app.evaluate(() => globalThis.i18nDialogs.at(-1));
    assert.equal(options.title, t('confirm.messageTitle'));
    assert.deepEqual(options.buttons, [t('common.cancel'), t('confirm.approve')]);
    assert.equal(options.defaultId, 0);
    assert.ok(options.detail.includes('Fixture {{name}}'));
    assert.ok(options.detail.includes('\u200e| '));
    snap('confirmation');
    result.screenshots.push(`${language}-confirmation.png`);
    // Cancellation uses the actual native Escape path.
    native('windowfocus', id);
    native('key', 'Escape');
    const rejected = await poll(
      () => wallet.evaluate(() => globalThis.i18nResult),
      'native cancellation',
    );
    assert.equal(rejected.ok, false);
    result.checks.push(
      'genuine native confirmation, static buttons, verbatim data, markers and Cancel',
    );

    await startRequest('Page review: ' + 'Review this data. '.repeat(65));
    let pageIndex = 1;
    for (;;) {
      const pageId = await nativeWindow();
      const pageOptions = await app.evaluate(() => globalThis.i18nDialogs.at(-1));
      const digits = pageOptions.message.split('\n')[0].match(/\d+/g).map(Number);
      assert.deepEqual(digits.slice(0, 2), [2, pageIndex]);
      assert.ok(digits[2] > 1 && digits[2] <= 10);
      const last = pageIndex === digits[2];
      assert.deepEqual(
        pageOptions.buttons,
        last ? [t('common.cancel'), t('confirm.approve')] : [t('common.next'), t('common.cancel')],
      );
      assert.equal(pageOptions.defaultId, last ? 0 : 1);
      snap(`page-${pageIndex}`);
      result.screenshots.push(`${language}-page-${pageIndex}.png`);
      if (last) {
        native('windowfocus', pageId);
        native('key', 'Escape');
        break;
      }
      const count = await app.evaluate(() => globalThis.i18nDialogs.length);
      const geometry = Object.fromEntries(
        native('getwindowgeometry', '--shell', pageId)
          .split('\n')
          .map((line) => line.split('=')),
      );
      native(
        'mousemove',
        '--window',
        pageId,
        String(Math.floor(Number(geometry.WIDTH) / 4)),
        String(Number(geometry.HEIGHT) - 18),
        'click',
        '1',
      );
      await poll(
        async () => (await app.evaluate(() => globalThis.i18nDialogs.length)) > count,
        'next native page',
      );
      pageIndex++;
    }
    assert.equal(
      (await poll(() => wallet.evaluate(() => globalThis.i18nResult), 'last-page cancellation')).ok,
      false,
    );
    result.checks.push(
      'native multi-page review, bold page indicators, Next and final-page approval',
    );

    await startRequest('Language-change cancellation');
    await nativeWindow();
    await wallet.evaluate(() => globalThis.window.qrlWallet.setLanguage('es'));
    const aborted = await poll(
      () => wallet.evaluate(() => globalThis.i18nResult),
      'language-change abort',
    );
    assert.equal(aborted.ok, false);
    assert.ok(aborted.error.includes(translate('es', 'error.languageConfirm')));
    await wallet.evaluate((code) => globalThis.window.qrlWallet.setLanguage(code), language);
    const menus = await app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu().items.flatMap(
        (item) => item.submenu?.items.map((child) => child.label) ?? [],
      ),
    );
    assert.ok(menus.includes(t('menu.settings')));
    const roles = await app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu().items.flatMap(
        (item) => item.submenu?.items.map((child) => child.role || child.type) ?? [],
      ),
    );
    assert.deepEqual(roles, ['normal', 'separator', 'quit']);
    result.checks.push('language change aborts open review and refreshes menus');
    result.result = 'PASS';
  } catch (error) {
    snap('failure');
    result.result = 'FAIL';
    result.error = error.stack ?? String(error);
    process.exitCode = 1;
  } finally {
    if (app) await app.close();
    await writeFile(path.join(evidence, 'results.json'), JSON.stringify(results, null, 2) + '\n');
    console.log(JSON.stringify(result));
  }
}
console.log(`Evidence: ${evidence}`);
