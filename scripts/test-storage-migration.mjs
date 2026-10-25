// Set QRL_LEGACY_APP to the extracted 1.4.5 app directory, with its built out/ tree.
// Usage: env -u DISPLAY -u WAYLAND_DISPLAY xvfb-run -a node scripts/test-storage-migration.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { electronTestArgs, isolatedEnvironment, waitForAppPage } from './electron-test-utils.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
assert.ok(process.env.QRL_FRONTEND_DIR, 'Set QRL_FRONTEND_DIR');
assert.ok(process.env.QRL_LEGACY_APP, 'Set QRL_LEGACY_APP to the built legacy app');
const legacy = path.resolve(process.env.QRL_LEGACY_APP);
const expectedVersion = process.env.QRL_LEGACY_VERSION ?? '1.4.5';
assert.equal(
  JSON.parse(await readFile(path.join(legacy, 'package.json'), 'utf8')).version,
  expectedVersion,
);
const { _electron } = createRequire(path.join(process.env.QRL_FRONTEND_DIR, 'package.json'))(
  'playwright',
);
const directory = await mkdtemp(path.join(tmpdir(), 'desktop-storage-migration-'));
const profile = path.join(directory, 'upgrade');
const failureProfile = path.join(directory, 'retry');
const statePath = (profile) => path.join(profile, 'user-data/v3-private');
const settingsPath = (profile) => path.join(statePath(profile), 'settings.json');
const legacyUrl = pathToFileURL(path.join(legacy, 'out/renderer/index.html')).href;
const contacts = [
  {
    id: 'contact-1',
    name: 'Migration contact one',
    address: `Q${'12'.repeat(64)}`,
    createdAt: 1720000000000,
  },
  {
    id: 'contact-2',
    name: 'Migration contact two',
    address: `Q${'34'.repeat(64)}`,
    createdAt: 1720000000001,
  },
];
const entries = [
  ['qrlwallet:v3:qrl:addressBook:qip55:v2', JSON.stringify(contacts)],
  ['qrlwallet:v3:WALLET_LANGUAGE', JSON.stringify('de')],
  ['qrlwallet:migration:raw', ' whitespace\n\u0000\ud800中文 '],
  ['qrlwallet:migration:empty', ''],
  ['qrlwallet:migration:unknown-future-key', '{ untouched value }'],
  ['qrl:transaction-history:v1:qrl:from:hash', '{ "transaction": "history fixture" }'],
  ['qrl_TOKEN_LIST_V3', '[{"symbol":"CUSTOM","address":"migration-token"}]'],
  ['@qrlwallet/connect:session', '{ "session": "migration fixture" }'],
  ['@qrlwallet/connect:session:inflight', '{ "request": "inflight fixture" }'],
  ['arbitrary-migration-key', 'arbitrary migration value'],
  ['unprefixed-empty-value', ''],
  ['', 'empty key migration value'],
];
const destinationEntries = [
  ['qrlwallet:migration:raw', 'existing destination value'],
  ['arbitrary-migration-key', ''],
];
const expectedEntries = entries.map(([key, value]) => [
  key,
  new Map(destinationEntries).get(key) ?? value,
]);
const failureLine = '[storage] wallet origin migration failed; will retry next launch';
const completeLine = '[storage] wallet origin migration complete';
let app;
async function launch(application, profile, extraEnv = {}) {
  let entrypoint = application;
  if (application === root) {
    // Observe both snapshots before frontend startup can expire SDK session fixtures.
    entrypoint = path.join(directory, 'observe-migration.cjs');
    await writeFile(
      entrypoint,
      `const assert = require('node:assert/strict');
const { ipcMain } = require('electron');
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => handle(channel, async (event, message) => {
  if (channel === 'storage:migrate-v1') {
    if (message.step === 'read') {
      assert.equal(event.senderFrame.url, 'file:///qrlwallet-storage-migration.html');
      globalThis.migrationSource = message.entries;
    }
    if (message.step === 'complete') {
      globalThis.migrationDestination = await event.sender.executeJavaScript('Object.entries(localStorage)');
    }
  }
  return handler(event, message);
});
import(${JSON.stringify(pathToFileURL(path.join(root, 'out/main/index.js')).href)});`,
    );
  }
  const instance = await _electron.launch({
    chromiumSandbox: true,
    executablePath:
      application === legacy || application.endsWith('read-source.cjs')
        ? path.join(root, 'node_modules/electron/dist/electron')
        : (process.env.QRL_MIGRATION_ELECTRON ??
          path.join(root, 'node_modules/electron/dist/electron')),
    args: [
      ...electronTestArgs(entrypoint),
      `--user-data-dir=${path.join(profile, 'user-data')}`,
      extraEnv.QRL_RENDERER_DEV_URL
        ? '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'
        : '--host-resolver-rules=MAP * ~NOTFOUND',
    ],
    env: { ...(await isolatedEnvironment(profile)), ...extraEnv },
    timeout: 60000,
  });
  return instance;
}
async function mockNetwork(instance) {
  // Install CDP request interception after the private startup helpers close.
  await instance.context().route(/^https?:/, async (route) => {
    const request = route.request();
    if (!request.url().includes('/qrl-rpc/')) {
      await route.fulfill({ json: {} });
      return;
    }
    const reply = ({ id, method }) => ({
      jsonrpc: '2.0',
      id,
      result:
        {
          qrl_chainId: '0x301825',
          net_listening: true,
          net_version: '3151909',
          qrl_getBlockByNumber: {
            number: '0x0',
            baseFeePerGas: '0x1',
            hash: '0xd15407991193e6c23b733dc6bf9c628deaff8f9b6e252aa0d60030952b3e3ea4',
          },
        }[method] ?? '0x0',
    });
    const payload = request.postDataJSON();
    await route.fulfill({ json: Array.isArray(payload) ? payload.map(reply) : reply(payload) });
  });
}
async function close() {
  await app?.close();
  app = undefined;
}
async function check(page, expected = entries) {
  await mockNetwork(app);
  await page.reload();
  for (const [key, value] of expected) {
    // The SDK expires the synthetic session during frontend startup. Its exact
    // copied value is asserted in the private helper before the UI opens.
    if (page.url().startsWith('app:') && key.startsWith('@qrlwallet/connect:session')) continue;
    assert.equal(
      await page.evaluate((key) => globalThis.localStorage.getItem(key), key),
      value,
      'stored value preserved',
    );
  }
  await page.waitForFunction(() => globalThis.document.documentElement.lang === 'de');
  await page.evaluate(() => {
    globalThis.location.hash = '/address-book';
  });
  for (const contact of contacts) await page.getByText(contact.name, { exact: true }).waitFor();
}
async function checkMigrationSnapshot(instance, source, expected) {
  const snapshots = await instance.evaluate(() => ({
    source: globalThis.migrationSource,
    destination: globalThis.migrationDestination,
  }));
  assert.deepEqual(
    Object.fromEntries(snapshots.source),
    source,
    'constant reader sees every legacy entry',
  );
  const destination = new Map(snapshots.destination);
  for (const [key, value] of expected) {
    assert.equal(destination.has(key), true, `destination contains fixture key ${key}`);
    assert.equal(destination.get(key), value, 'helper copies strings unchanged');
  }
}
async function seedDestination(profile) {
  const helper = path.join(directory, 'seed-destination.cjs');
  await writeFile(
    helper,
    `const { app, BrowserWindow, protocol } = require('electron');
app.setPath('userData', ${JSON.stringify(statePath(profile))});
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true } }]);
app.whenReady().then(async () => {
  protocol.handle('app', () => new Response('<!doctype html><title>Destination fixture</title>', { headers: { 'Content-Type': 'text/html' } }));
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await win.loadURL('app://wallet/index.html');
});`,
  );
  const helperApp = await launch(helper, profile);
  try {
    const page = await waitForAppPage(helperApp);
    await page.evaluate((entries) => {
      for (const [key, value] of entries) globalThis.localStorage.setItem(key, value);
    }, destinationEntries);
    await helperApp.evaluate(({ session }) => session.defaultSession.flushStorageData());
  } finally {
    await helperApp.close();
  }
}
async function snapshotSource(profile) {
  // Read the legacy origin through an inert test helper, without running frontend code.
  const helper = path.join(directory, 'read-source.cjs');
  await writeFile(
    helper,
    `const { app, BrowserWindow, protocol } = require('electron');
app.setPath('userData', ${JSON.stringify(statePath(profile))});
app.whenReady().then(async () => {
  protocol.handle('file', () => new Response('<!doctype html><title>Storage test helper</title>', { headers: { 'Content-Type': 'text/html' } }));
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await win.loadURL(${JSON.stringify(legacyUrl)});
});`,
  );
  const helperApp = await launch(helper, profile);
  try {
    const page = await waitForAppPage(helperApp, legacyUrl);
    return await page.evaluate(() =>
      Object.fromEntries(
        Object.keys(globalThis.localStorage).map((key) => [
          key,
          globalThis.localStorage.getItem(key),
        ]),
      ),
    );
  } finally {
    await helperApp.close();
  }
}

try {
  app = await launch(legacy, profile);
  const oldPage = await waitForAppPage(app, legacyUrl);
  assert.equal(await app.evaluate(({ app }) => app.getVersion()), expectedVersion);
  await oldPage.evaluate((entries) => {
    for (const [key, value] of entries) globalThis.localStorage.setItem(key, value);
  }, entries);
  await check(oldPage);
  // Store the final fixture after legacy UI startup has consumed old SDK sessions.
  // These writes still run in the real 1.4.5 window at its installed index URL.
  await oldPage.evaluate((entries) => {
    for (const [key, value] of entries) globalThis.localStorage.setItem(key, value);
  }, entries);
  await app.evaluate(({ session }) => session.defaultSession.flushStorageData());
  await close();
  const source = await snapshotSource(profile);
  for (const [key, value] of entries) assert.equal(source[key], value, 'legacy fixture persisted');
  await seedDestination(profile);
  await cp(profile, failureProfile, { recursive: true });
  console.log(
    `Legacy ${expectedVersion} profile: contacts, language, unprefixed keys, empty strings and raw fixtures verified`,
  );

  app = await launch(root, profile);
  let page = await waitForAppPage(app);
  await checkMigrationSnapshot(
    app,
    source,
    Object.entries({
      ...source,
      ...Object.fromEntries(destinationEntries),
    }),
  );
  await check(page, expectedEntries);
  assert.equal(
    JSON.parse(await readFile(settingsPath(profile), 'utf8')).walletOriginMigrationV1,
    true,
  );
  await page.evaluate(() =>
    globalThis.localStorage.setItem('qrlwallet:migration:raw', 'changed after migration'),
  );
  await app.evaluate(({ session }) => session.defaultSession.flushStorageData());
  await close();
  assert.deepEqual(await snapshotSource(profile), source, 'legacy source is untouched');
  app = await launch(root, profile);
  page = await waitForAppPage(app);
  assert.equal(await app.evaluate(() => globalThis.migrationSource), undefined);
  await check(
    page,
    expectedEntries.map(([key, value]) => [
      key,
      key === 'qrlwallet:migration:raw' ? 'changed after migration' : value,
    ]),
  );
  await close();
  const log = await readFile(path.join(statePath(profile), 'logs/main.log'), 'utf8');
  assert.equal(log.split(completeLine).length - 1, 1);
  console.log(
    'Upgrade and second launch: contacts/language preserved, copy runs once, original storage unchanged',
  );

  // A failed settings commit keeps startup available and the copy retryable.
  const oldSettings = await readFile(settingsPath(failureProfile), 'utf8');
  await rm(settingsPath(failureProfile));
  await mkdir(settingsPath(failureProfile));
  app = await launch(root, failureProfile);
  page = await waitForAppPage(app);
  await checkMigrationSnapshot(
    app,
    source,
    Object.entries({
      ...source,
      ...Object.fromEntries(destinationEntries),
    }),
  );
  await check(page, expectedEntries);
  const walletWindow = await app.browserWindow(page);
  assert.equal(await walletWindow.evaluate((window) => window.isVisible()), true);
  assert.equal(
    await app.evaluate(({ ipcMain }) => ipcMain._invokeHandlers.has('storage:migrate-v1')),
    false,
  );
  await assert.rejects(readFile(settingsPath(failureProfile)), { code: 'EISDIR' });
  await page.evaluate(() => {
    globalThis.localStorage.setItem('qrlwallet:migration:raw', 'edited after failed launch');
    globalThis.localStorage.setItem('retry-new-key', 'written after failed launch');
    globalThis.localStorage.removeItem('arbitrary-migration-key');
  });
  await app.evaluate(({ session }) => session.defaultSession.flushStorageData());
  await close();
  const failureLog = await readFile(path.join(statePath(failureProfile), 'logs/main.log'), 'utf8');
  assert.equal(failureLog.split(failureLine).length - 1, 1);
  assert.equal(failureLog.includes('startup FAILED'), false);
  assert.equal(failureLog.includes(completeLine), false);
  for (const [key, value] of [...entries, ...destinationEntries]) {
    if (key) assert.equal(failureLog.includes(key), false);
    if (value.length > 3) assert.equal(failureLog.includes(value), false);
  }
  assert.deepEqual(await snapshotSource(failureProfile), source);
  await rm(settingsPath(failureProfile), { recursive: true });
  await writeFile(settingsPath(failureProfile), oldSettings);
  assert.equal(JSON.parse(oldSettings).walletOriginMigrationV1, undefined);
  app = await launch(root, failureProfile);
  page = await waitForAppPage(app);
  const retryEntries = entries.map(([key, value]) => [
    key,
    key === 'qrlwallet:migration:raw' ? 'edited after failed launch' : value,
  ]);
  retryEntries.push(['retry-new-key', 'written after failed launch']);
  await checkMigrationSnapshot(app, source, retryEntries);
  await check(page, retryEntries);
  assert.equal(
    JSON.parse(await readFile(settingsPath(failureProfile), 'utf8')).walletOriginMigrationV1,
    true,
  );
  await page.evaluate(() => globalThis.localStorage.removeItem('arbitrary-migration-key'));
  await app.evaluate(({ session }) => session.defaultSession.flushStorageData());
  await close();
  app = await launch(root, failureProfile);
  page = await waitForAppPage(app);
  assert.equal(await app.evaluate(() => globalThis.migrationSource), undefined);
  await check(
    page,
    retryEntries.filter(([key]) => key !== 'arbitrary-migration-key'),
  );
  assert.equal(
    await page.evaluate(() => globalThis.localStorage.getItem('arbitrary-migration-key')),
    null,
    'completed migration skips the copy on later launches',
  );
  await close();
  const retryLog = await readFile(path.join(statePath(failureProfile), 'logs/main.log'), 'utf8');
  assert.equal(retryLog.split(failureLine).length - 1, 1);
  assert.equal(retryLog.split(completeLine).length - 1, 1);
  assert.deepEqual(await snapshotSource(failureProfile), source);
  console.log(
    'Failed completion: wallet opens, fixed private log, source intact; retry preserves newer values; later launch skips copy',
  );

  for (const mode of ['load-failure', 'timeout']) {
    const helperFailure = path.join(directory, `${mode}.cjs`);
    const helperProfile = path.join(directory, mode);
    await writeFile(
      helperFailure,
      `const { BrowserWindow } = require('electron');
const loadURL = BrowserWindow.prototype.loadURL;
BrowserWindow.prototype.loadURL = function(url, ...args) {
  if (url === 'file:///qrlwallet-storage-migration.html') {
    return ${mode === 'timeout' ? 'new Promise(() => {})' : "Promise.reject(new Error('private migration error detail'))"};
  }
  return loadURL.call(this, url, ...args);
};
import(${JSON.stringify(pathToFileURL(path.join(root, 'out/main/index.js')).href)});`,
    );
    const started = Date.now();
    app = await launch(helperFailure, helperProfile);
    page = await waitForAppPage(app);
    const elapsed = Date.now() - started;
    if (mode === 'timeout') assert.ok(elapsed >= 29000 && elapsed < 45000);
    await mockNetwork(app);
    await page.reload();
    await page.getByRole('link', { name: 'Create a new account', exact: true }).first().waitFor();
    assert.equal(
      await (await app.browserWindow(page)).evaluate((window) => window.isVisible()),
      true,
    );
    assert.equal(
      await app.evaluate(({ ipcMain }) => ipcMain._invokeHandlers.has('storage:migrate-v1')),
      false,
    );
    await close();
    const settings = JSON.parse(
      await readFile(settingsPath(helperProfile), 'utf8').catch(() => '{}'),
    );
    assert.equal(settings.walletOriginMigrationV1, undefined);
    const log = await readFile(path.join(statePath(helperProfile), 'logs/main.log'), 'utf8');
    assert.equal(log.split(failureLine).length - 1, 1);
    assert.equal(log.includes('private migration error detail'), false);
    assert.equal(log.includes('startup FAILED'), false);
    assert.equal(log.includes(completeLine), false);
    console.log(`${mode}: wallet opens, completion unset, helper cleaned up, fixed failure log`);
  }

  const fresh = path.join(directory, 'fresh');
  app = await launch(root, fresh);
  page = await waitForAppPage(app);
  await mockNetwork(app);
  await page.reload();
  await page.getByRole('link', { name: 'Create a new account', exact: true }).first().waitFor();
  assert.equal(
    JSON.parse(await readFile(settingsPath(fresh), 'utf8')).walletOriginMigrationV1,
    true,
  );
  await close();
  console.log('Fresh profile: onboarding and empty migration succeed');

  const guardHarness = path.join(directory, 'helper-guards.cjs');
  await writeFile(
    guardHarness,
    `const assert = require('node:assert/strict');
const { ipcMain, webContents } = require('electron');
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => handle(channel, async (event, message) => {
  if (channel === 'storage:migrate-v1') {
    for (const forged of [{ ...event, senderFrame: null }, { ...event, sender: {} }]) {
      await assert.rejects(async () => handler(forged, message), /unauthorized/);
    }
    if (message.step === 'read') {
      assert.equal(event.senderFrame.url, 'file:///qrlwallet-storage-migration.html');
      const prefs = event.sender.getLastWebPreferences();
      assert.equal(prefs.webSecurity, false);
      assert.equal(prefs.sandbox, true);
      assert.equal(prefs.contextIsolation, true);
      assert.equal(prefs.nodeIntegration, false);
      assert.equal(prefs.allowRunningInsecureContent, false);
      await assert.rejects(async () => handler(event, { step: 'write' }), /invalid migration phase/);
      await assert.rejects(async () => handler(event, { ...message, extra: true }), /invalid migration message/);
      const debuggerApi = event.sender.debugger;
      debuggerApi.attach('1.3');
      try {
        // Bypass CSP only in this test to exercise the file request filter independently.
        await debuggerApi.sendCommand('Page.setBypassCSP', { enabled: true });
        const blocked = await event.sender.executeJavaScript('fetch(location.href).then(() => false, () => true)');
        assert.equal(blocked, true, 'legacy helper file fetch denied even with CSP bypassed');
      } finally {
        await debuggerApi.sendCommand('Page.setBypassCSP', { enabled: false });
        debuggerApi.detach();
      }
    }
    if (message.step === 'write') {
      assert.equal(event.sender.getLastWebPreferences().webSecurity, true);
      assert.ok(webContents.getAllWebContents().every((contents) => !contents.getURL().startsWith('file:')));
    }
  }
  return handler(event, message);
});
import(${JSON.stringify(pathToFileURL(path.join(root, 'out/main/index.js')).href)});`,
  );
  app = await launch(guardHarness, path.join(directory, 'helper-guards'));
  page = await waitForAppPage(app);
  await mockNetwork(app);
  await page.reload();
  await page.getByRole('link', { name: 'Create a new account', exact: true }).first().waitFor();
  assert.equal(
    await app.evaluate(({ ipcMain }) => ipcMain._invokeHandlers.has('storage:migrate-v1')),
    false,
  );
  await close();
  console.log(
    'Helper guards: sender/frame/schema/phase checks, file filter independent of CSP, reader destroyed, IPC removed',
  );

  // A normal frontend development server works without a staged wallet bundle.
  const devApp = path.join(directory, 'dev-app');
  await mkdir(devApp);
  await cp(path.join(root, 'package.json'), path.join(devApp, 'package.json'));
  await symlink(path.join(root, 'node_modules'), path.join(devApp, 'node_modules'), 'dir');
  for (const target of ['main', 'preload', 'unlock', 'settings']) {
    await cp(path.join(root, 'out', target), path.join(devApp, 'out', target), { recursive: true });
  }
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(
      '<!doctype html><title>Development server fixture</title>Development server fixture',
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const devUrl = `http://127.0.0.1:${server.address().port}/`;
    const devProfile = path.join(directory, 'development');
    app = await launch(devApp, devProfile, { QRL_RENDERER_DEV_URL: devUrl });
    page = await waitForAppPage(app, devUrl);
    await page.getByText('Development server fixture', { exact: true }).waitFor();
    await page.evaluate(() => globalThis.qrlWallet.setLanguage('de'));
    const settings = JSON.parse(await readFile(settingsPath(devProfile), 'utf8'));
    assert.equal(settings.language, 'de');
    assert.equal(settings.walletOriginMigrationV1, undefined);
    await close();
  } finally {
    await close();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  console.log(
    'Development server: renderer/preload IPC work without a bundled frontend; migration skipped',
  );
} finally {
  await close();
  await rm(directory, { recursive: true, force: true });
}
