// Uses the release validation approach: real Electron, isolated Xvfb/profile,
// Playwright for app-owned unlock and settings windows.
import assert from 'node:assert/strict';
import { electronTestArgs, waitForAppPage } from './electron-test-utils.mjs';
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
      args: [
        ...electronTestArgs(root, frontend),
        `--lang=${language}`,
        `--user-data-dir=${path.join(profile, 'user-data')}`,
        '--host-resolver-rules=MAP * ~NOTFOUND',
      ],
      cwd: root,
      env,
      timeout: 60000,
    });
    // Keep the native window probe offline.
    const wallet = await waitForAppPage(app);
    await app.context().route(/^https?:/, (route) => route.abort());
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
          .find((page) => page.url().startsWith('app://unlock/')),
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
          .find((page) => page.url().startsWith('app://settings/')),
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
    // Preserve external shell errors verbatim, including in the English UI.
    await app.evaluate(({ shell }) => {
      shell.openPath = async () => 'Failed to open path';
    });
    await settings.getByRole('button', { name: t('settings.logs'), exact: true }).click();
    const logsError = settings.locator('.settings-status.error');
    await logsError.waitFor();
    assert.equal(await logsError.innerText(), 'Failed to open path');
    await wallet.evaluate(() => globalThis.window.qrlWallet.setLanguage('en'));
    await settings.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
    assert.equal(await logsError.innerText(), 'Failed to open path');
    await wallet.evaluate((code) => globalThis.window.qrlWallet.setLanguage(code), language);
    await settings.getByRole('heading', { name: t('settings.title'), exact: true }).waitFor();
    result.checks.push('external settings error matches English output without an added label');
    await settings.getByRole('button', { name: t('settings.back'), exact: true }).click();
    result.checks.push('settings save, live status translation, no clipped controls at 720 x 560');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 800));

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
    result.checks.push('live menu translation preserves native roles');
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
