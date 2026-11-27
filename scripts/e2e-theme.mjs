// Colour theme end to end: real Electron, isolated Xvfb and profile, Playwright
// for the wallet window, the native unlock window and the settings panel.
// The OS appearance is stated per run: QRL_THEME_OS=dark or light (default
// light) sets GTK_THEME to Adwaita:dark or Adwaita for the app, which is what
// nativeTheme reads under Xvfb; the run first checks that the app sees it.
// Checks: with nothing stored the app follows that appearance (system default)
// from the first frame and writes nothing; a light choice reaches the store,
// nativeTheme, every window background, the wallet bridge, the settings panel
// and the unlock window after a lock (from the creation-time argument alone,
// with main's pulls held); `system` follows an emulated OS flip; a restart
// keeps the choice from the first frame; an invalid stored value reads as the
// default and keeps the other preferences.
// The choice goes through the renderer's Theme row when the bundled renderer
// has one, else through window.qrlWallet.setTheme. QRL_THEME_EXPECT_ROW=1
// requires the row.
// Usage: env -u DISPLAY -u WAYLAND_DISPLAY QRL_FRONTEND_DIR=<frontend> QRL_THEME_OS=dark|light xvfb-run -a npm run test:e2e:theme
import assert from 'node:assert/strict';
import { electronTestArgs, isolatedEnvironment, waitForAppPage } from './electron-test-utils.mjs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const frontend = process.env.QRL_FRONTEND_DIR ?? path.join(root, 'out/frontend-source');
const require = createRequire(path.join(frontend, 'package.json'));
const { _electron } = require('playwright');
const evidence =
  process.env.QRL_THEME_EVIDENCE ?? (await mkdtemp(path.join(tmpdir(), 'desktop-theme-e2e-')));
await mkdir(evidence, { recursive: true });
const profile = await mkdtemp(path.join(evidence, 'profile-'));
const env = await isolatedEnvironment(profile);
const OS = process.env.QRL_THEME_OS ?? 'light';
assert.ok(OS === 'dark' || OS === 'light', 'QRL_THEME_OS is dark or light');
env.GTK_THEME = OS === 'dark' ? 'Adwaita:dark' : 'Adwaita';
const settingsFile = path.join(profile, 'user-data/v3-private/settings.json');
const fixture = {
  hexSeed: '010000' + '01'.repeat(48),
  password: 'ThemeFixture!123',
  useKeychain: false,
};
const LIGHT_BG = 'rgb(243, 244, 247)';
const DARK_BG = 'rgb(8, 12, 22)';
// What the system default shows under this run's OS appearance.
const OS_LOOK = OS === 'dark' ? { attr: null, bg: DARK_BG } : { attr: 'light', bg: LIGHT_BG };
const OS_HEX = OS === 'dark' ? '#080c16' : '#f3f4f7';
const result = { os: OS, checks: [], choiceVia: null, screenshots: [] };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function poll(fn, description) {
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    const value = await fn();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Timed out: ${description}`);
}

async function stored() {
  try {
    return JSON.parse(await readFile(settingsFile, 'utf8'));
  } catch {
    return null;
  }
}

function launch() {
  return _electron.launch({
    chromiumSandbox: true,
    executablePath: path.join(root, 'node_modules/electron/dist/electron'),
    args: [
      ...electronTestArgs(root, frontend),
      `--user-data-dir=${path.join(profile, 'user-data')}`,
      '--host-resolver-rules=MAP * ~NOTFOUND',
    ],
    cwd: root,
    env,
    timeout: 60000,
  });
}

const page = (app, prefix) =>
  poll(
    () =>
      app
        .context()
        .pages()
        .find((p) => p.url().startsWith(prefix)),
    prefix,
  );

const look = (target) =>
  target.evaluate(() => ({
    attr: globalThis.document.documentElement.getAttribute('data-theme'),
    bg: globalThis.getComputedStyle(globalThis.document.body).backgroundColor,
  }));

const windows = (app) =>
  app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => ({
      url: w.webContents.getURL(),
      bg: w.getBackgroundColor().toLowerCase(),
    })),
  );

async function unlockWith(app) {
  const unlock = await page(app, 'app://unlock/');
  await unlock.locator('input[type="password"]').waitFor({ state: 'visible' });
  return unlock;
}

async function submitUnlock(unlock) {
  await unlock.locator('input[type="password"]').fill(fixture.password);
  const closed = unlock.waitForEvent('close', { timeout: 45000 });
  await unlock.locator('button.unlock-button').click();
  await closed;
}

let app;
try {
  // 1. Nothing stored: the system default shows the OS appearance from the
  // first frame, and nothing is written.
  app = await launch();
  await app.context().route(/^https?:/, (route) => route.abort());
  assert.equal(
    await app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors),
    OS === 'dark',
    `the app sees the ${OS} OS appearance`,
  );
  let wallet = await waitForAppPage(app);
  assert.deepEqual(await wallet.evaluate(() => globalThis.qrlWallet.theme), {
    theme: 'system',
    resolved: OS,
  });
  assert.equal(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource), 'system');
  assert.ok((await windows(app)).some((w) => w.url.startsWith('app://wallet/') && w.bg === OS_HEX));
  assert.equal(await look(wallet).then((value) => value.attr), OS_LOOK.attr);
  await wallet.evaluate((f) => globalThis.qrlWallet.importWallet(f), fixture);
  await wallet.evaluate(() => globalThis.qrlWallet.lock());
  let unlock = await unlockWith(app);
  assert.deepEqual(await look(unlock), OS_LOOK);
  assert.ok((await windows(app)).some((w) => w.url.startsWith('app://unlock/') && w.bg === OS_HEX));
  await submitUnlock(unlock);
  assert.equal((await stored())?.theme, undefined, 'nothing stores the default');
  result.checks.push(
    `system default with nothing stored: ${OS} wallet bridge, page, window backgrounds and unlock window; nothing written`,
  );

  // 2. Choose light: the Theme row when the renderer has one, else the bridge.
  await wallet.evaluate(() => {
    globalThis.themeEvents = [];
    globalThis.qrlWallet.onThemeChanged((state) => globalThis.themeEvents.push(state));
  });
  await wallet.evaluate(() => {
    globalThis.location.hash = '/settings';
  });
  await delay(1500);
  const row = wallet.getByLabel('Theme', { exact: true });
  if ((await row.count()) > 0) {
    await row.first().selectOption('light');
    result.choiceVia = 'row';
  } else {
    assert.notEqual(process.env.QRL_THEME_EXPECT_ROW, '1', 'the renderer has no Theme row');
    await wallet.evaluate(() => globalThis.qrlWallet.setTheme('light'));
    result.choiceVia = 'bridge';
  }
  await poll(async () => (await stored())?.theme === 'light', 'light stored');
  assert.equal(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource), 'light');
  assert.deepEqual(await wallet.evaluate(() => globalThis.themeEvents), [
    { theme: 'light', resolved: 'light' },
  ]);
  assert.equal(
    await wallet.evaluate(() => globalThis.matchMedia('(prefers-color-scheme: light)').matches),
    true,
  );
  assert.ok(
    (await windows(app)).some((w) => w.url.startsWith('app://wallet/') && w.bg === '#f3f4f7'),
  );
  await assert.rejects(
    wallet.evaluate(() => globalThis.qrlWallet.setTheme('blue')),
    /invalid request/,
  );
  result.checks.push(
    `light chosen via ${result.choiceVia}: store, nativeTheme, bridge event, renderer media query, window background`,
  );

  // 3. The settings panel and the unlock window follow, from their creation-time
  // argument: for the rest of this run main's pulls never answer, and no push
  // comes without a change, so only the argument can set the light set here.
  // The restart in step 5 uses the real pull handlers again.
  await app.evaluate(({ ipcMain }) => {
    for (const channel of ['settings:getTheme', 'unlock:getTheme']) {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, () => new Promise(() => undefined));
    }
  });
  await wallet.evaluate(() => globalThis.qrlWallet.openDesktopSettings());
  let settings = await page(app, 'app://settings/');
  await settings.getByText('Back to wallet').waitFor({ state: 'visible' });
  assert.deepEqual(await look(settings), { attr: 'light', bg: LIGHT_BG });
  await settings.screenshot({ path: path.join(evidence, 'settings-light.png') });
  result.screenshots.push('settings-light.png');
  await settings.getByText('Back to wallet').click();
  await delay(500);
  await wallet.evaluate(() => globalThis.qrlWallet.lock());
  unlock = await unlockWith(app);
  assert.deepEqual(await look(unlock), { attr: 'light', bg: LIGHT_BG });
  assert.ok(
    (await windows(app)).some((w) => w.url.startsWith('app://unlock/') && w.bg === '#f3f4f7'),
  );
  await unlock.screenshot({ path: path.join(evidence, 'unlock-light.png') });
  result.screenshots.push('unlock-light.png');
  await submitUnlock(unlock);
  result.checks.push(
    'settings panel and unlock window light from the creation-time argument alone (pulls held), unlock window background light',
  );

  // 4. system follows an emulated OS appearance flip.
  await wallet.evaluate(() => globalThis.qrlWallet.setTheme('system'));
  const flip = (dark) =>
    app.evaluate(({ nativeTheme }, value) => {
      Object.defineProperty(nativeTheme, 'shouldUseDarkColors', {
        configurable: true,
        get: () => value,
      });
      nativeTheme.emit('updated');
    }, dark);
  await flip(true);
  await poll(
    () => wallet.evaluate(() => globalThis.themeEvents.at(-1)?.resolved === 'dark'),
    'system resolved dark',
  );
  await wallet.evaluate(() => globalThis.qrlWallet.openDesktopSettings());
  settings = await page(app, 'app://settings/');
  await settings.getByText('Back to wallet').waitFor({ state: 'visible' });
  assert.deepEqual(await look(settings), { attr: null, bg: DARK_BG });
  await flip(false);
  await poll(
    () => wallet.evaluate(() => globalThis.themeEvents.at(-1)?.resolved === 'light'),
    'system resolved light',
  );
  await poll(async () => (await look(settings)).attr === 'light', 'open panel follows the flip');
  assert.deepEqual(await wallet.evaluate(() => globalThis.themeEvents.at(-1)), {
    theme: 'system',
    resolved: 'light',
  });
  await settings.getByText('Back to wallet').click();
  await delay(500);
  result.checks.push('system follows an emulated OS flip live (wallet event, open settings panel)');

  // 5. A restart keeps the choice from the first frame.
  await wallet.evaluate(() => globalThis.qrlWallet.setTheme('light'));
  await poll(async () => (await stored())?.theme === 'light', 'light stored again');
  await app.close();
  app = await launch();
  await app.context().route(/^https?:/, (route) => route.abort());
  unlock = await unlockWith(app);
  assert.deepEqual(await look(unlock), { attr: 'light', bg: LIGHT_BG });
  await submitUnlock(unlock);
  wallet = await waitForAppPage(app);
  assert.deepEqual(await wallet.evaluate(() => globalThis.qrlWallet.theme), {
    theme: 'light',
    resolved: 'light',
  });
  // First frame: light window background from creation, and the renderer's
  // boot script applied the light set before the app rendered.
  assert.ok(
    (await windows(app)).some((w) => w.url.startsWith('app://wallet/') && w.bg === '#f3f4f7'),
  );
  assert.equal(await look(wallet).then((value) => value.attr), 'light');
  result.checks.push(
    'restart keeps light: unlock window, wallet window background, wallet bridge and page',
  );
  await app.close();

  // 6. An invalid stored value reads as the default (system, so the OS
  // appearance) and keeps the other preferences.
  const before = await stored();
  await writeFile(settingsFile, JSON.stringify({ ...before, theme: 'blue', language: 'de' }));
  app = await launch();
  await app.context().route(/^https?:/, (route) => route.abort());
  unlock = await unlockWith(app);
  assert.deepEqual(await look(unlock), OS_LOOK);
  assert.ok((await windows(app)).some((w) => w.url.startsWith('app://unlock/') && w.bg === OS_HEX));
  assert.equal(await unlock.evaluate(() => globalThis.document.documentElement.lang), 'de');
  await submitUnlock(unlock);
  wallet = await waitForAppPage(app);
  assert.deepEqual(await wallet.evaluate(() => globalThis.qrlWallet.theme), {
    theme: 'system',
    resolved: OS,
  });
  result.checks.push(`invalid stored theme reads as the system default (${OS}), language kept`);
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  console.log('PASS');
} finally {
  await app?.close().catch(() => undefined);
  console.log(`Evidence: ${evidence}`);
}
