// Usage: env -u DISPLAY -u WAYLAND_DISPLAY xvfb-run -a node scripts/test-file-access.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { electronTestArgs, isolatedEnvironment, waitForAppPage } from './electron-test-utils.mjs';
import { keystore } from './extension-wallet-fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
assert.ok(process.env.QRL_FRONTEND_DIR, 'Set QRL_FRONTEND_DIR to the built frontend checkout');
const { _electron } = createRequire(path.join(process.env.QRL_FRONTEND_DIR, 'package.json'))(
  'playwright',
);
const profile = await mkdtemp(path.join(tmpdir(), 'desktop-file-access-'));
const env = await isolatedEnvironment(profile);
const created = [];
let app;

// Runs unchanged in documents, inherited-origin iframes and all worker kinds.
async function probe({ file, control, classic = false }) {
  const results = {};
  const attempt = async (name, action) => {
    try {
      await action();
      results[name] = 'loaded';
    } catch {
      results[name] = 'blocked';
    }
  };
  const xhr = (url) =>
    new Promise((resolve, reject) => {
      const request = new globalThis.XMLHttpRequest();
      request.open('GET', url);
      request.onload = () =>
        request.status === 200 || request.responseText.includes('file-access-control')
          ? resolve()
          : reject(new Error('failed'));
      request.onerror = () => reject(new Error('blocked'));
      request.ontimeout = () => reject(new Error('timeout'));
      request.timeout = 3000;
      request.send();
    });
  const worker = (url, shared, module) =>
    new Promise((resolve, reject) => {
      const instance = shared
        ? new globalThis.SharedWorker(url, {
            type: module ? 'module' : 'classic',
            name: `child-${module ? 'module' : 'classic'}`,
          })
        : new globalThis.Worker(url, { type: module ? 'module' : 'classic' });
      const port = shared ? instance.port : instance;
      const finish = (ok) => {
        clearTimeout(timer);
        if (shared) port.close();
        else instance.terminate();
        if (ok) resolve();
        else reject(new Error('blocked'));
      };
      const timer = setTimeout(() => finish(false), 3000);
      port.onmessage = () => finish(true);
      instance.onerror = (event) => {
        event.preventDefault();
        finish(false);
      };
      if (shared) port.start();
    });
  await attempt('control-fetch', async () => {
    if (!(await fetch(control)).ok) throw new Error('failed');
  });
  await attempt('control-xhr', () => xhr(control));
  await attempt('control-import', () => import(control));
  await attempt('file-fetch', async () => {
    const response = await fetch(file);
    if (!response.ok) throw new Error('denied');
    await response.text();
  });
  await attempt('file-xhr', () => xhr(file));
  await attempt('file-import', () => import(file));
  if (typeof globalThis.importScripts === 'function') {
    if (classic) await attempt('control-importScripts', () => globalThis.importScripts(control));
    await attempt('file-importScripts', () => globalThis.importScripts(file));
  }
  if (typeof globalThis.Worker === 'function') {
    await attempt('file-static-module-import', () =>
      worker(control.replace('control.js', 'module-import.js'), false, true),
    );
    await attempt('cross-origin-worker', () =>
      worker(
        control
          .replace(
            /app:\/\/[^/]+/,
            control.startsWith('app://wallet/') ? 'app://unlock' : 'app://wallet',
          )
          .replace('control.js', 'child.js'),
        false,
        false,
      ),
    );
    for (const module of [false, true]) {
      await attempt(`control-worker-${module ? 'module' : 'classic'}`, () =>
        worker(control.replace('control.js', 'child.js'), false, module),
      );
      await attempt(`file-worker-${module ? 'module' : 'classic'}`, () =>
        worker(file, false, module),
      );
    }
  }
  if (typeof globalThis.SharedWorker === 'function') {
    await attempt('file-static-shared-import', () =>
      worker(control.replace('control.js', 'module-import.js'), true, true),
    );
    for (const module of [false, true]) {
      await attempt(`control-shared-${module ? 'module' : 'classic'}`, () =>
        worker(control.replace('control.js', 'child.js'), true, module),
      );
      await attempt(`file-shared-${module ? 'module' : 'classic'}`, () =>
        worker(file, true, module),
      );
    }
  }
  return { origin: globalThis.location.origin, results };
}

function verify(result, name, origin) {
  assert.equal(result.origin, origin, name);
  for (const operation of ['fetch', 'xhr', 'import']) {
    assert.equal(result.results[`control-${operation}`], 'loaded', name);
    assert.equal(result.results[`file-${operation}`], 'blocked', name);
  }
  for (const [operation, state] of Object.entries(result.results)) {
    assert.equal(
      state,
      operation.startsWith('control-') ? 'loaded' : 'blocked',
      `${name}: ${operation}`,
    );
  }
  console.log(`${name}: ${Object.keys(result.results).join(', ')}`);
}

async function surface(page, host, file, source = 'external') {
  const origin = `app://${host}`;
  const args = { file, control: `${origin}/file-access-control.js` };
  verify(await page.evaluate(probe, args), `${host} ${source} document`, origin);
  await page.evaluate(() => {
    const frame = globalThis.document.createElement('iframe');
    frame.id = 'file-access-frame';
    frame.srcdoc = '<!doctype html><title>Inherited origin probe</title>';
    globalThis.document.body.append(frame);
  });
  const iframe = await page.locator('#file-access-frame').elementHandle();
  const frame = await iframe.contentFrame();
  // about:srcdoc reports a null location.origin while inheriting its parent's security origin.
  verify(await frame.evaluate(probe, args), `${host} ${source} iframe`, 'null');
  await page.locator('#file-access-frame').evaluate((element) => element.remove());
  for (const kind of ['classic', 'module', 'shared-classic', 'shared-module']) {
    const result = await page.evaluate(
      ({ origin, kind, args }) =>
        new Promise((resolve, reject) => {
          const shared = kind.startsWith('shared');
          const options = {
            type: kind.endsWith('module') ? 'module' : 'classic',
            name: `file-access-${kind}`,
          };
          const instance = shared
            ? new globalThis.SharedWorker(`${origin}/file-access-probe.js`, options)
            : new globalThis.Worker(`${origin}/file-access-probe.js`, options);
          const port = shared ? instance.port : instance;
          const timer = setTimeout(() => reject(new Error('worker probe timed out')), 20000);
          port.onmessage = ({ data }) => {
            clearTimeout(timer);
            if (shared) port.close();
            else instance.terminate();
            resolve(data);
          };
          instance.onerror = (event) => {
            clearTimeout(timer);
            reject(new Error(event.message || 'worker failed'));
          };
          if (shared) port.start();
          port.postMessage(args);
        }),
      { origin, kind, args: { ...args, classic: !kind.endsWith('module') } },
    );
    verify(result, `${host} ${source} ${kind} worker`, origin);
  }
  await page.evaluate((file) => {
    const frame = globalThis.document.createElement('iframe');
    frame.id = 'file-document-frame';
    frame.src = file;
    globalThis.document.body.append(frame);
  }, file);
  await page.waitForTimeout(300);
  assert.ok(page.frames().every((frame) => !frame.url().startsWith('file:')));
  await page.locator('#file-document-frame').evaluate((element) => element.remove());
  const documentUrl = page.url();
  await page.evaluate((file) => {
    globalThis.location.href = file;
  }, file);
  await page.waitForTimeout(100);
  assert.equal(page.url(), documentUrl, 'file document navigation denied');
  const headers = await page.evaluate(async () =>
    Object.fromEntries((await fetch(globalThis.location.href.split('#')[0])).headers),
  );
  assert.match(headers['content-security-policy'], /worker-src 'self'/);
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.equal(headers['x-dns-prefetch-control'], 'off');
  await page.evaluate((host) => {
    globalThis.localStorage.setItem('origin-isolation', host);
    globalThis.originMessages = [];
    globalThis.originChannel?.close();
    globalThis.originChannel = new globalThis.BroadcastChannel('origin-isolation');
    globalThis.originChannel.onmessage = (event) => globalThis.originMessages.push(event.data);
    globalThis.originChannel.postMessage(host);
  }, host);
}

async function verifyNativeSenders(host) {
  const checks = await app.evaluate(async ({ ipcMain, webContents }, host) => {
    const sender = webContents
      .getAllWebContents()
      .find((contents) => contents.getURL() === `app://${host}/index.html`);
    const event = { sender, senderFrame: sender.mainFrame };
    const handlers = [...ipcMain._invokeHandlers].filter(([channel]) =>
      channel.startsWith(`${host}:`),
    );
    const results = [];
    for (const [, handler] of handlers) {
      for (const forged of [
        { ...event, sender: {} },
        { ...event, senderFrame: null },
        { ...event, senderFrame: { url: sender.mainFrame.url } },
      ]) {
        try {
          await handler(forged);
          results.push(false);
        } catch (error) {
          results.push(error.message === 'unauthorized');
        }
      }
    }
    const language = await ipcMain._invokeHandlers.get(`${host}:getLanguage`)(event);
    return { results, language };
  }, host);
  assert.ok(
    checks.results.length > 0 && checks.results.every(Boolean),
    `${host} sender/frame gates`,
  );
  assert.equal(checks.language, 'en');
  console.log(`${host}: all native IPC sender/frame gates rejected forged events`);
}

try {
  const control = '// file-access-control\n';
  const filePath = path.join(profile, 'host-script.js');
  await writeFile(
    filePath,
    control +
      'if ("onconnect" in globalThis) onconnect = e => e.ports[0].postMessage("file loaded"); else if (!globalThis.document) postMessage("file loaded");',
  );
  const file = pathToFileURL(filePath).href;
  for (const directory of ['renderer', 'unlock', 'settings']) {
    for (const [name, contents] of [
      ['file-access-control.js', control],
      [
        'file-access-child.js',
        control +
          'if ("onconnect" in globalThis) onconnect = e => e.ports[0].postMessage("control"); else postMessage("control");',
      ],
      [
        'file-access-module-import.js',
        `import ${JSON.stringify(file)}; if ('onconnect' in globalThis) onconnect = e => e.ports[0].postMessage('loaded'); else postMessage('loaded');`,
      ],
      [
        'file-access-probe.js',
        `const probe = ${probe.toString()};\nconst bind = port => { port.onmessage = async event => port.postMessage(await probe(event.data)); port.start?.(); };\nif ('onconnect' in globalThis) onconnect = event => bind(event.ports[0]); else bind(globalThis);`,
      ],
    ]) {
      const target = path.join(root, 'out', directory, name);
      await writeFile(target, contents, { flag: 'wx' });
      created.push(target);
    }
    const escape = path.join(root, 'out', directory, 'file-access-escape.js');
    await symlink(filePath, escape);
    created.push(escape);
  }
  app = await _electron.launch({
    chromiumSandbox: true,
    executablePath:
      process.env.QRL_FILE_ACCESS_ELECTRON ??
      path.join(root, 'node_modules/electron/dist/electron'),
    args: [
      ...electronTestArgs(root),
      `--user-data-dir=${path.join(profile, 'user-data')}`,
      '--host-resolver-rules=MAP * ~NOTFOUND',
    ],
    env,
    timeout: 60000,
  });
  const wallet = await waitForAppPage(app);
  await app.context().route(/^https?:/, (route) => route.abort());
  const workers = [];
  wallet.on('worker', (worker) => workers.push(worker.url()));
  await wallet.evaluate(() => {
    globalThis.location.hash = '/import-account';
  });
  await wallet.getByRole('tab', { name: 'Import Encrypted Wallet', exact: true }).click();
  await wallet.locator('input[type="file"]').setInputFiles({
    name: 'extension.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(keystore)),
  });
  await wallet.locator('input[name="password"]').fill('correct horse battery staple');
  await wallet.locator('button[type="submit"]').click();
  await wallet.getByRole('heading', { name: 'Set Wallet Password', exact: true }).waitFor();
  await wallet.locator('input[name="password"]').fill('FileAccessFixture!123');
  await wallet.locator('input[name="reEnteredPassword"]').fill('FileAccessFixture!123');
  await wallet.locator('button[type="submit"]').click();
  await wallet.getByRole('heading', { name: 'Account imported', exact: true }).waitFor();
  assert.ok(workers.some((url) => url.startsWith('app://wallet/assets/cryptoWorker-')));
  assert.equal((await wallet.evaluate(() => globalThis.qrlWallet.listWallets())).wallets.length, 1);
  console.log('Encrypted extension-wallet import: bundled app worker and signer completed');
  await surface(wallet, 'wallet', file);
  await surface(
    wallet,
    'wallet',
    pathToFileURL(path.join(root, 'out/renderer/file-access-child.js')).href,
    'bundled-file',
  );
  await wallet.evaluate(() => globalThis.qrlWallet.openDesktopSettings());
  const settings = await waitForAppPage(app, 'app://settings/index.html');
  await verifyNativeSenders('settings');
  await surface(settings, 'settings', file);
  await surface(
    settings,
    'settings',
    pathToFileURL(path.join(root, 'out/settings/file-access-child.js')).href,
    'bundled-file',
  );
  assert.equal(
    await wallet.evaluate(() => globalThis.localStorage.getItem('origin-isolation')),
    'wallet',
  );
  assert.deepEqual(await wallet.evaluate(() => globalThis.originMessages), []);
  assert.deepEqual(await settings.evaluate(() => globalThis.originMessages), []);
  await wallet.evaluate(() => globalThis.qrlWallet.lock());
  const unlock = await waitForAppPage(app, 'app://unlock/index.html');
  await verifyNativeSenders('unlock');
  await surface(unlock, 'unlock', file);
  await surface(
    unlock,
    'unlock',
    pathToFileURL(path.join(root, 'out/unlock/file-access-child.js')).href,
    'bundled-file',
  );
  assert.equal(
    await wallet.evaluate(() => globalThis.localStorage.getItem('origin-isolation')),
    'wallet',
  );
  assert.deepEqual(await wallet.evaluate(() => globalThis.originMessages), []);
  assert.deepEqual(await unlock.evaluate(() => globalThis.originMessages), []);
  for (const host of ['wallet', 'unlock', 'settings']) {
    for (const url of [`app://${host}/file-access-escape.js`, `app://${host}/missing`]) {
      const result = await app.evaluate(async ({ net }, url) => {
        const response = await net.fetch(url);
        return { status: response.status, headers: Object.fromEntries(response.headers) };
      }, url);
      assert.ok([403, 404].includes(result.status));
      assert.equal(result.headers['x-content-type-options'], 'nosniff');
    }
  }
  const fileResponse = await app.evaluate(async ({ net }, file) => {
    try {
      const response = await net.fetch(file);
      return response.ok;
    } catch {
      return false;
    }
  }, file);
  assert.equal(fileResponse, false);
  console.log(
    'Origin storage, globalThis.BroadcastChannel, worker scope, symlink containment and file denial passed',
  );
} finally {
  await app?.close();
  for (const file of created) await rm(file, { force: true });
  await rm(profile, { recursive: true, force: true });
}
