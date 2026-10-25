// Real Electron, production signer and native UI; public fixtures, isolated profile.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { translate } from '../src/shared/i18n.ts';
import { electronTestArgs, waitForAppPage } from './electron-test-utils.mjs';

assert.match(process.env.DISPLAY ?? '', /^:(?!0(?:\.|$))\d+/u);
assert.ok(!process.env.WAYLAND_DISPLAY);
const root = fileURLToPath(new URL('../', import.meta.url));
const frontend = process.env.QRL_FRONTEND_DIR ?? path.join(root, 'out/frontend-source');
const { _electron } = createRequire(path.join(frontend, 'package.json'))('playwright');
const size = process.env.QRL_UNLOCK_SIZE;
const scale = Number(process.env.QRL_UNLOCK_SCALE);
assert.ok(['1024x768', '1280x720'].includes(size));
assert.ok([1, 1.25].includes(scale));
const [width, height] = size.split('x').map(Number);
const evidence = path.join(process.env.QRL_UNLOCK_EVIDENCE, `${size}-${scale}`);
await mkdir(evidence, { recursive: true });
const env = {};
for (const key of ['PATH', 'DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS']) {
  if (process.env[key]) env[key] = process.env[key];
}
for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR']) {
  env[key] = path.join(evidence, key.toLowerCase());
  await mkdir(env[key], { recursive: true, mode: 0o700 });
}
env.QRL_RPC_URL_SECONDARY = 'none';
env.QRL_AUTOLOCK_MS = '300000';
env.LANG = 'en_US.UTF-8';
const password = 'PublicNativeUnlockFixture123';
const results = [];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function poll(fn, name) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await pause(100);
  }
  throw new Error(`Timed out: ${name}`);
}
let app;
async function launch() {
  const instance = await _electron.launch({
    executablePath: path.join(root, 'node_modules/electron/dist/electron'),
    args: [...electronTestArgs(root), `--user-data-dir=${path.join(evidence, 'user-data')}`],
    cwd: root,
    env,
    timeout: 60000,
  });
  await instance.context().route(/^https?:/u, (route) => route.abort());
  return instance;
}
async function nativePage(surface) {
  return poll(
    () =>
      app
        .context()
        .pages()
        .find((page) => !page.isClosed() && page.url().includes(`/${surface}/`)),
    surface,
  );
}
async function scaleText(page) {
  await page.evaluate(async (factor) => {
    await globalThis.document.fonts.ready;
    const elements = [
      ...globalThis.document.querySelectorAll('p, button, select, input, h1, span, label, option'),
    ];
    for (const element of elements) element.style.removeProperty('font-size');
    // Snapshot first so inherited sizes are scaled exactly once. This changes
    // text alone; window geometry and non-text padding retain production sizes.
    const sizes = elements.map((element) =>
      parseFloat(globalThis.getComputedStyle(element).fontSize),
    );
    elements.forEach((element, index) => {
      element.style.fontSize = `${sizes[index] * factor}px`;
    });
  }, scale);
}
async function checkLayout(page, selectors) {
  const metrics = await page.evaluate((selectors) => {
    const elements = [...globalThis.document.querySelectorAll(selectors)];
    return {
      width: globalThis.innerWidth,
      height: globalThis.innerHeight,
      elements: elements.map((element) => {
        const r = element.getBoundingClientRect();
        const range = globalThis.document.createRange();
        range.selectNodeContents(element);
        return {
          tag: element.tagName,
          class: element.className,
          x: r.x,
          y: r.y,
          right: r.right,
          bottom: r.bottom,
          width: r.width,
          height: r.height,
          clipped:
            element.scrollWidth > element.clientWidth + 1 ||
            element.scrollHeight > element.clientHeight + 1,
          text: [...range.getClientRects()].map((rect) => ({
            x: rect.x,
            y: rect.y,
            right: rect.right,
            bottom: rect.bottom,
          })),
        };
      }),
    };
  }, selectors);
  for (const element of metrics.elements) {
    assert.ok(
      element.x >= 0 &&
        element.y >= 0 &&
        element.right <= metrics.width + 1 &&
        element.bottom <= metrics.height + 1,
      JSON.stringify(element),
    );
    assert.equal(element.clipped, false, JSON.stringify(element));
    for (const rect of element.text)
      assert.ok(
        rect.x >= 0 &&
          rect.y >= 0 &&
          rect.right <= metrics.width + 1 &&
          rect.bottom <= metrics.height + 1,
        JSON.stringify(element),
      );
  }
  return metrics;
}
const snap = (name) =>
  execFileSync('import', ['-window', 'root', path.join(evidence, `${name}.png`)], {
    env,
    timeout: 15000,
  });
try {
  app = await launch();
  // A fresh profile opens the startup storage helpers before the wallet.
  const wallet = await waitForAppPage(app);
  await wallet.waitForFunction(() => Boolean(globalThis.window.qrlWallet));
  await app.evaluate(
    ({ BrowserWindow }, bounds) =>
      BrowserWindow.getAllWindows()
        .find((win) => win.webContents.getURL().startsWith('app://wallet/'))
        ?.setBounds(bounds),
    { x: 0, y: 0, width, height },
  );
  const actualWorkArea = await app.evaluate(
    ({ screen }) => screen.getPrimaryDisplay().workAreaSize,
  );
  assert.deepEqual(actualWorkArea, { width, height });
  const accounts = [];
  for (const byte of ['01', '02']) {
    const status = await wallet.evaluate(
      ({ byte, password }) =>
        globalThis.window.qrlWallet.importWallet({
          hexSeed: '010000' + byte.repeat(48),
          password,
          useKeychain: false,
        }),
      { byte, password },
    );
    accounts.push(status.address);
  }
  // Linux has no Touch ID hardware. Advertise the button only in this probe
  // to measure the tallest UI state. The real handler still rejects unavailable
  // biometrics; the separate IPC test covers successful keychain forwarding.
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('unlock:getInfo');
    assertFunction(original);
    function assertFunction(value) {
      if (typeof value !== 'function') throw new Error('missing unlock handler');
    }
    ipcMain.removeHandler('unlock:getInfo');
    ipcMain.handle('unlock:getInfo', async (event, ...args) => {
      const info = await original(event, ...args);
      return {
        ...info,
        wallets: info.wallets.map((wallet) => ({ ...wallet, keychainBacked: true })),
      };
    });
  });
  const userData = await app.evaluate(({ app }) => app.getPath('userData'));
  for (const language of ['en', 'de', 'es', 'ru', 'zh-CN']) {
    const t = (key) => translate(language, key);
    await wallet.evaluate(
      (language) => globalThis.window.qrlWallet.setLanguage(language),
      language,
    );
    await wallet.evaluate(() => globalThis.window.qrlWallet.openDesktopSettings());
    const settings = await nativePage('settings');
    await settings.getByLabel(t('settings.autolock'), { exact: true }).waitFor();
    // The actual wallet file loader must deny the settings file.
    const fileProbe = await wallet.evaluate(
      async (url) => {
        try {
          const response = await fetch(url);
          return { status: response.status, body: await response.text() };
        } catch {
          return { status: 0, body: '' };
        }
      },
      pathToFileURL(path.join(userData, 'settings.json')).href,
    );
    assert.notEqual(fileProbe.status, 200);
    assert.notEqual(fileProbe.body, await readFile(path.join(userData, 'settings.json'), 'utf8'));
    assert.equal(
      await wallet.evaluate(
        () => 'unlockBridge' in globalThis.window || 'settingsBridge' in globalThis.window,
      ),
      false,
    );
    await scaleText(settings);
    const settingsMetrics = [];
    await checkLayout(settings, '.settings-back, .settings-title, .settings-version');
    snap(`${language}-settings`);
    const cards = settings.locator('.settings-card');
    assert.ok((await cards.count()) > 0);
    for (let index = 0; index < (await cards.count()); index += 1) {
      await cards.nth(index).scrollIntoViewIfNeeded();
      settingsMetrics.push(
        await checkLayout(
          settings,
          `.settings-card:nth-of-type(${index + 1}), .settings-card:nth-of-type(${index + 1}) :is(p, button, select, input, span, label)`,
        ),
      );
    }
    // The back button closes this view, so the page can go away while the
    // click is still settling; only a click that left it open is a failure.
    const closed = settings.isClosed() ? Promise.resolve() : settings.waitForEvent('close');
    await settings
      .getByRole('button', { name: t('settings.back'), exact: true })
      .click()
      .catch((error) => {
        if (!settings.isClosed()) throw error;
      });
    await closed;
    await wallet.evaluate(() => globalThis.window.qrlWallet.lock());
    const unlock = await nativePage('unlock');
    await unlock.getByPlaceholder(t('unlock.password')).waitFor();
    assert.equal(await unlock.getByPlaceholder(t('unlock.password')).isEnabled(), true);
    assert.equal(
      await unlock.getByRole('button', { name: t('unlock.submit'), exact: true }).isEnabled(),
      false,
    );
    assert.equal(
      await unlock.getByRole('button', { name: t('unlock.touchId'), exact: true }).isEnabled(),
      true,
    );
    assert.equal(
      await unlock
        .getByPlaceholder(t('unlock.password'))
        .evaluate((element) => element === globalThis.document.activeElement),
      true,
      'password has initial keyboard focus',
    );
    assert.equal(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((win) => win.webContents.getURL().startsWith('app://wallet/'))
          .isVisible(),
      ),
      false,
    );
    await unlock.getByLabel(t('unlock.account'), { exact: true }).selectOption(accounts[0]);
    await unlock.getByPlaceholder(t('unlock.password')).fill('wrong');
    await unlock.getByRole('button', { name: t('unlock.submit'), exact: true }).click();
    await unlock.getByText(t('unlock.incorrect'), { exact: true }).waitFor();
    await scaleText(unlock);
    const metrics = await checkLayout(
      unlock,
      '.unlock-logo, .unlock-wordmark, .unlock-account-select, .unlock-input, .unlock-eye, .unlock-button, .unlock-biometric, .unlock-error, .unlock-hint',
    );
    snap(`${language}-unlock`);
    results.push({ language, size, scale, metrics, settingsMetrics });
    await unlock.getByRole('button', { name: t('unlock.touchId'), exact: true }).click();
    await unlock.getByText(t('unlock.biometricUnavailable'), { exact: true }).waitFor();
    await unlock.getByPlaceholder(t('unlock.password')).fill(password);
    await wallet.evaluate(() => globalThis.window.qrlWallet.setLanguage('es'));
    assert.equal(
      await unlock.getByPlaceholder(translate('es', 'unlock.password')).inputValue(),
      password,
    );
    await wallet.evaluate(
      (language) => globalThis.window.qrlWallet.setLanguage(language),
      language,
    );
    await unlock.getByPlaceholder(t('unlock.password')).fill(password);
    await unlock.getByRole('button', { name: t('unlock.submit'), exact: true }).click();
    await poll(() => unlock.isClosed(), 'successful unlock closes window');
    const status = await wallet.evaluate(() => globalThis.window.qrlWallet.getStatus());
    assert.equal(status.locked, false);
    assert.equal(status.address, accounts[0], 'account picker selects the unlocked account');
    console.log(`PASS ${language} ${size} text=${scale}`);
  }
  // Exercise the production autolock timer with a short, test-owned override.
  await wallet.evaluate(() => globalThis.window.qrlWallet.openDesktopSettings());
  const settings = await nativePage('settings');
  await settings.locator('.settings-select').waitFor();
  await app.evaluate(() => {
    process.env.QRL_AUTOLOCK_MS = '1000';
  });
  await settings.evaluate(() => globalThis.window.settingsBridge.set({ autolockMs: 60000 }));
  const autolock = await nativePage('unlock');
  await autolock.locator('.unlock-input').waitFor();
  assert.equal(settings.isClosed(), true, 'autolock destroys settings');
  assert.equal((await wallet.evaluate(() => globalThis.window.qrlWallet.getStatus())).locked, true);
  const closed = app.waitForEvent('close');
  await app
    .evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((win) => win.webContents.getURL().includes('/unlock/'))
        .close(),
    )
    .catch(() => undefined);
  await closed;
  app = null;
  // Relaunch opens the native unlock window with the saved language and accounts.
  app = await launch();
  const restarted = await nativePage('unlock');
  await restarted.getByPlaceholder(translate('zh-CN', 'unlock.password')).waitFor();
  assert.equal(await restarted.locator('.unlock-input').isEnabled(), true);
  assert.equal(await restarted.locator('.unlock-account-select').inputValue(), accounts[0]);
  await writeFile(
    path.join(evidence, 'results.json'),
    JSON.stringify(
      {
        results,
        lifecycle:
          'password, wrong password, biometric fallback, account picker, language change, autolock, locked close, restart, file denial: PASS',
      },
      null,
      2,
    ),
  );
} catch (error) {
  snap('failure');
  throw error;
} finally {
  if (app) await app.close();
}
