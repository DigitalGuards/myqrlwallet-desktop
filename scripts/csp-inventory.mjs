// Run the pinned desktop renderer with synthetic holdings and an isolated Xvfb profile.
// Usage: env -u DISPLAY -u WAYLAND_DISPLAY xvfb-run -a node scripts/csp-inventory.mjs
import assert from 'node:assert/strict';
import { electronTestArgs, waitForAppPage } from './electron-test-utils.mjs';
import { keystore } from './extension-wallet-fixture.mjs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createSocket } from 'node:dgram';
import { newWalletFromExtendedSeed } from '@theqrl/wallet.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const frontend = process.env.QRL_FRONTEND_DIR;
assert.ok(frontend, 'Set QRL_FRONTEND_DIR to the pinned frontend checkout');
const require = createRequire(path.join(frontend, 'package.json'));
const { _electron } = require('playwright');
assert.match(process.env.DISPLAY ?? '', /^:(?!0(?:\.|$))\d+/);
assert.ok(!process.env.WAYLAND_DISPLAY, 'Use a private Xvfb display');
const evidence =
  process.env.QRL_CSP_EVIDENCE ?? (await mkdtemp(path.join(tmpdir(), 'desktop-csp-')));
await mkdir(evidence, { recursive: true });
const profile = await mkdtemp(path.join(tmpdir(), 'desktop-csp-profile-'));
const tight = process.env.QRL_CSP_EXPECT_TIGHT !== '0';
const password = 'CspFixture!123';
const contract = `Q${'12'.repeat(64)}`;
const httpsContract = `Q${'34'.repeat(64)}`;
const imageUrl = 'https://art.example/nft.svg';
const ipfsUrl = 'ipfs://bafybeicspfixture/art.svg';
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#38bdf8"/></svg>';
const genesis = '0xd15407991193e6c23b733dc6bf9c628deaff8f9b6e252aa0d60030952b3e3ea4';
const report = {
  tight,
  screens: [],
  requests: [],
  servedImages: [],
  workers: [],
  violations: [],
  consoleErrors: [],
  checks: [],
};
let screen = 'startup';
let account;
let app;
let wallet;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cleanUrl = (url) =>
  url
    .replace(/^file:.*\/out\//, 'bundle:/')
    .replace(/^file:\/\//, 'bundle:')
    .replace(/^data:.*/, 'data: (inline image)');
const env = {};
for (const key of ['PATH', 'DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS']) {
  if (process.env[key]) env[key] = process.env[key];
}
for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR']) {
  env[key] = path.join(profile, key.toLowerCase());
  await mkdir(env[key], { recursive: true, mode: 0o700 });
}
env.LANG = 'en_US.UTF-8';
env.QRL_RPC_URL_SECONDARY = 'none';

function rpc(payload) {
  if (Array.isArray(payload)) return payload.map(rpc);
  const { id, method, params } = payload;
  let result;
  switch (method) {
    case 'qrl_chainId':
      result = '0x301825';
      break;
    case 'qrl_getBlockByNumber':
      result = { hash: genesis, number: '0x0', baseFeePerGas: '0x1' };
      break;
    case 'net_listening':
      result = true;
      break;
    case 'net_version':
      result = '3151909';
      break;
    case 'qrl_getBalance':
      result = '0xde0b6b3a7640000';
      break;
    case 'qrl_blockNumber':
      result = '0x1';
      break;
    case 'qrl_getCode':
      result = '0x01';
      break;
    case 'qrl_call':
      result =
        params?.[0]?.data?.startsWith('0x6352211e') && account
          ? `0x${account.slice(1).toLowerCase()}`
          : `0x${'0'.repeat(63)}1`;
      break;
    default:
      result = '0x0';
  }
  return { jsonrpc: '2.0', id, result };
}

async function snapshot(name, screenshot = true) {
  screen = name;
  await delay(650);
  const files = await app.evaluate(() => globalThis.cspFiles.splice(0));
  for (const url of files) {
    const type = /\.woff2?(?:$|\?)/.test(url)
      ? 'font'
      : /\.(?:svg|png|ico|webp|jpg)(?:$|\?)/.test(url)
        ? 'image'
        : /\.mp4(?:$|\?)/.test(url)
          ? 'media'
          : /\/cryptoWorker-/.test(url)
            ? 'worker'
            : 'other';
    if (type !== 'other')
      report.requests.push({ screen, type, url: cleanUrl(url), observer: 'bundle-reader' });
  }
  const view = await wallet.evaluate(() => ({
    images: [...globalThis.document.images].map((img) => ({
      src: img.currentSrc || img.src,
      complete: img.complete,
      width: img.naturalWidth,
    })),
    placeholders: [...globalThis.document.querySelectorAll('[role="img"][aria-label]')].map(
      (el) => ({
        label: el.getAttribute('aria-label'),
        width: el.getBoundingClientRect().width,
        height: el.getBoundingClientRect().height,
      }),
    ),
    overflow: globalThis.document.documentElement.scrollWidth > globalThis.innerWidth,
    media: [...globalThis.document.querySelectorAll('video, audio')].map((el) => el.currentSrc),
    inlineSvg: globalThis.document.querySelectorAll('svg').length,
    cssDataImage: globalThis
      .getComputedStyle(globalThis.document.body)
      .backgroundImage.includes('data:image/'),
  }));
  for (const img of view.images) img.src = cleanUrl(img.src);
  view.media = view.media.map(cleanUrl);
  report.screens.push({ name, ...view });
  if (screenshot) await wallet.screenshot({ path: path.join(evidence, `${name}.png`) });
  console.log(`Screen: ${name}`);
  return view;
}

async function go(route, name) {
  screen = name;
  await wallet.evaluate((route) => {
    globalThis.location.hash = route;
  }, route);
  return snapshot(name);
}

async function finishImport(name) {
  await wallet.getByRole('heading', { name: 'Set Wallet Password', exact: true }).waitFor();
  await wallet.locator('input[name="password"]').fill(password);
  await wallet.locator('input[name="reEnteredPassword"]').fill(password);
  await wallet.locator('button[type="submit"]').click();
  await wallet.getByRole('heading', { name: 'Account imported', exact: true }).waitFor();
  await snapshot(name);
}

try {
  app = await _electron.launch({
    chromiumSandbox: true,
    executablePath: path.join(root, 'node_modules/electron/dist/electron'),
    args: [
      ...electronTestArgs(root),
      `--user-data-dir=${path.join(profile, 'user-data')}`,
      '--host-resolver-rules=MAP * ~NOTFOUND',
    ],
    cwd: root,
    env,
    timeout: 60000,
  });
  const context = app.context();
  const userData = await app.evaluate(({ app }) => app.getPath('userData'));
  assert.ok(userData.startsWith(profile + path.sep), 'Electron uses the isolated test profile');
  report.runtime = await app.evaluate(() => ({
    electron: process.versions.electron,
    chromium: process.versions.chrome,
  }));
  await app.evaluate(({ session, shell }) => {
    globalThis.cspFiles = [];
    globalThis.cspExternal = [];
    const reader = session.fromPartition('bundle-reader');
    const originalFetch = reader.fetch.bind(reader);
    reader.fetch = (url, options) => {
      if (String(url).startsWith('file:')) globalThis.cspFiles.push(String(url));
      return originalFetch(url, options);
    };
    shell.openExternal = async (url) => {
      globalThis.cspExternal.push(url);
    };
  });
  wallet = await waitForAppPage(app);
  await context.route(/^https?:/, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.resourceType() === 'image') {
      report.servedImages.push(request.url());
      await route.fulfill({ contentType: 'image/svg+xml', body: svg });
    } else if (url.pathname.includes('/qrl-rpc/')) {
      await route.fulfill({ json: rpc(request.postDataJSON()) });
    } else if (url.pathname.endsWith('/nfts')) {
      await route.fulfill({
        json: {
          nfts: [
            {
              contractAddress: contract,
              tokenStandard: 'ERC-721',
              tokenID: '1',
              collectionName: 'CSP fixtures',
              name: 'IPFS artwork',
              image: ipfsUrl,
            },
            {
              contractAddress: httpsContract,
              tokenStandard: 'ERC-721',
              tokenID: '2',
              collectionName: 'HTTPS collection',
              name: 'HTTPS artwork',
              image: imageUrl,
            },
          ],
        },
      });
    } else if (url.pathname.endsWith('/tokens')) {
      await route.fulfill({
        json: {
          tokens: [
            {
              contractAddress: contract,
              name: 'CSP token',
              symbol: 'CSP',
              decimals: 18,
              balance: '1000000000000000000',
              logo: imageUrl,
            },
          ],
        },
      });
    } else if (url.pathname.endsWith('/overview')) {
      await route.fulfill({ json: { market: { price: 1 } } });
    } else {
      await route.fulfill({ json: { transactions: [], data: [], success: true } });
    }
  });
  wallet.on('pageerror', (error) => report.consoleErrors.push({ screen, text: error.message }));
  context.on('request', (request) => {
    report.requests.push({ screen, type: request.resourceType(), url: cleanUrl(request.url()) });
  });
  wallet.on('worker', (worker) => {
    const request = { screen, url: cleanUrl(worker.url()) };
    report.workers.push(request);
    report.requests.push({ ...request, type: 'worker' });
  });
  wallet.on('console', (msg) => {
    if (msg.type() === 'error')
      report.consoleErrors.push({ screen, text: msg.text().replaceAll(root, '<bundle>') });
  });
  await wallet.exposeFunction('recordCspViolation', (event) =>
    report.violations.push({ screen, ...event }),
  );
  await wallet.exposeFunction('recordLocalImage', () => {
    report.requests.push({
      screen,
      type: 'image',
      url: 'data:image/svg+xml (QR copy)',
      observer: 'image-load',
    });
  });
  await wallet.addInitScript(() => {
    globalThis.document.addEventListener('securitypolicyviolation', (event) => {
      globalThis.recordCspViolation({
        directive: event.effectiveDirective,
        blocked: event.blockedURI,
      });
    });
    const descriptor = Object.getOwnPropertyDescriptor(
      globalThis.HTMLImageElement.prototype,
      'src',
    );
    Object.defineProperty(globalThis.HTMLImageElement.prototype, 'src', {
      ...descriptor,
      set(value) {
        if (String(value).startsWith('data:image/')) {
          this.addEventListener(
            'load',
            () => {
              globalThis.recordLocalImage();
            },
            { once: true },
          );
        }
        descriptor.set.call(this, value);
      },
    });
  });
  await wallet.reload();
  report.headers = await wallet.evaluate(async () => {
    const response = await fetch(globalThis.location.href.split('#')[0]);
    return Object.fromEntries(response.headers);
  });
  if (tight) {
    assert.match(report.headers['x-dns-prefetch-control'], /^off(?:, off)*$/);
    assert.match(
      report.headers['content-security-policy'],
      /img-src 'self' data: https:\/\/qrlwallet\.com;/,
    );
    assert.doesNotMatch(report.headers['content-security-policy'], /worker-src 'self' blob:/);
  }
  await wallet.getByRole('link', { name: 'Create a new account', exact: true }).first().waitFor();
  await snapshot('home-empty');
  await go('/create-account', 'create-form');
  await wallet.locator('input[name="password"]').fill(password);
  await wallet.locator('input[name="reEnteredPassword"]').fill(password);
  await wallet.locator('button[type="submit"]').click();
  for (let i = 0; i < 300; i += 1) {
    const list = await wallet.evaluate(() => globalThis.qrlWallet.listWallets());
    if (list.wallets?.length) {
      account = list.wallets[0].address;
      break;
    }
    await delay(100);
  }
  assert.ok(account, 'Create account persisted an isolated wallet');
  await wallet.getByRole('heading', { name: 'Your Recovery Information', exact: true }).waitFor();
  await snapshot('create-backup', false);
  await go('/', 'home-account');
  screen = 'tokens-picker';
  await wallet.getByRole('button', { name: 'Review and add', exact: true }).first().click();
  await snapshot('tokens-picker');
  await wallet.getByRole('checkbox').check();
  await wallet.getByRole('button', { name: /Add Selected/ }).click();
  await snapshot('tokens');
  screen = 'nft-picker';
  await wallet.getByRole('button', { name: 'Review and add', exact: true }).click();
  const pickerView = await snapshot('nft-picker');
  if (tight) {
    assert.equal(pickerView.placeholders.length, 1);
    assert.equal(pickerView.placeholders[0].width, 40);
    assert.equal(pickerView.placeholders[0].height, 40);
    assert.ok(pickerView.images.some((img) => img.src.includes('/api/ipfs/') && img.width === 120));
  }
  for (const checkbox of await wallet.getByRole('checkbox').all()) await checkbox.check();
  screen = 'nft-collections';
  await wallet.getByRole('button', { name: /Add Selected/ }).click();
  await snapshot('nft-collections');
  await go(`/?collection=${contract.toLowerCase()}`, 'nft-gallery');
  await go(`/nft/${contract}/1`, 'nft-ipfs');
  const ipfsImage = wallet.getByRole('img', { name: 'IPFS artwork', exact: true });
  assert.equal(await ipfsImage.evaluate((el) => el.naturalWidth), 120);
  const ipfsBounds = await ipfsImage.boundingBox();
  const httpsView = await go(`/nft/${httpsContract}/2`, 'nft-https');
  if (tight) {
    assert.equal(httpsView.placeholders.length, 1);
    assert.ok(httpsView.placeholders[0].width > 100 && httpsView.placeholders[0].height > 100);
    assert.equal(httpsView.overflow, false);
    assert.equal(httpsView.placeholders[0].width, ipfsBounds.width);
    assert.equal(httpsView.placeholders[0].height, ipfsBounds.height);
    const errorCount = report.consoleErrors.length;
    const requestCount = report.requests.length;
    await delay(2500);
    assert.equal(
      report.consoleErrors.length,
      errorCount,
      'Image failures settle without repeated console errors',
    );
    assert.equal(
      report.requests.length,
      requestCount,
      'Image failures settle without repeated requests',
    );
  } else {
    assert.equal(
      await wallet
        .getByRole('img', { name: 'HTTPS artwork', exact: true })
        .evaluate((el) => el.naturalWidth),
      120,
    );
  }
  report.checks.push('IPFS artwork and plain HTTPS NFT detail');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(800, 700));
  const compact = await snapshot('nft-https-compact');
  assert.equal(compact.overflow, false);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 800));
  for (const [route, name] of [
    ['/account-list', 'accounts'],
    ['/transfer', 'transfer'],
    ['/tx-history', 'history'],
    ['/address-book', 'contacts'],
    ['/dapp-sessions', 'dapps'],
    ['/settings', 'settings'],
  ])
    await go(route, name);
  await go('/account-list', 'accounts-qr');
  await wallet.getByRole('button', { name: 'Show address QR code', exact: true }).click();
  await snapshot('address-qr');
  await wallet.getByRole('button', { name: 'Copy QR', exact: true }).click();
  await snapshot('address-qr-copy');
  assert.ok(report.requests.some((request) => request.observer === 'image-load'));
  await wallet.getByRole('button', { name: 'Close', exact: true }).click();
  await go('/import-account', 'import-mnemonic');
  const mnemonicFixture = newWalletFromExtendedSeed('010000' + '02'.repeat(48));
  try {
    await wallet.locator('[name="mnemonicPhrases"]').fill(mnemonicFixture.getMnemonic());
  } finally {
    mnemonicFixture.zeroize();
  }
  await wallet.locator('button[type="submit"]').click();
  await finishImport('import-mnemonic-success');
  await go('/', 'home-after-mnemonic');
  await go('/import-account', 'import-hex-form');
  await wallet.getByRole('tab', { name: 'Import with Hex Seed', exact: true }).click();
  await snapshot('import-hex');
  await wallet.locator('[name="hexSeed"]').fill('0x010000' + '03'.repeat(48));
  await wallet.locator('button[type="submit"]').click();
  await finishImport('import-hex-success');
  await go('/', 'home-after-hex');
  await go('/import-account', 'import-encrypted-form');
  await wallet.getByRole('tab', { name: 'Import Encrypted Wallet', exact: true }).click();
  await wallet.locator('input[type="file"]').setInputFiles({
    name: 'csp-fixture.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(keystore)),
  });
  await wallet.locator('input[name="password"]').fill('correct horse battery staple');
  await snapshot('import-encrypted');
  await wallet.locator('button[type="submit"]').click();
  await wallet.getByRole('heading', { name: 'Set Wallet Password', exact: true }).waitFor();
  await snapshot('import-decrypted');
  assert.ok(report.workers.some((worker) => worker.url.includes('cryptoWorker-')));
  assert.ok(report.workers.every((worker) => worker.url.startsWith('app://wallet/')));
  await finishImport('import-success');
  const wallets = await wallet.evaluate(() => globalThis.qrlWallet.listWallets());
  assert.equal(wallets.wallets.length, 4, 'Creation and all three import modes persist accounts');
  report.checks.push(
    'Encrypted extension wallet imported through bundled app-origin worker and signer',
  );
  screen = 'channel-probes';
  const policy = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.getWebRTCIPHandlingPolicy(),
  );
  if (tight) assert.equal(policy, 'disable_non_proxied_udp');
  const socket = createSocket('udp4');
  let packets = 0;
  socket.on('message', () => {
    packets += 1;
  });
  await new Promise((resolve) => socket.bind(0, 'localhost', resolve));
  try {
    const bound = socket.address();
    await wallet.evaluate(async (url) => {
      const peer = new globalThis.RTCPeerConnection({ iceServers: [{ urls: url }] });
      globalThis.cspPeer = peer;
      peer.createDataChannel('synthetic');
      await peer.setLocalDescription(await peer.createOffer());
    }, `stun:${bound.address}:${bound.port}`);
    await delay(1800);
    await wallet.evaluate(() => globalThis.cspPeer.close());
    if (tight) assert.equal(packets, 0);
    else assert.ok(packets > 0, 'Baseline sends STUN without a media permission');
    report.webRtc = { policy, packets };
  } finally {
    socket.close();
  }
  const blobWorker = await wallet.evaluate(async () => {
    const url = URL.createObjectURL(
      new Blob(['postMessage("synthetic")'], { type: 'text/javascript' }),
    );
    try {
      return await new Promise((resolve) => {
        let worker;
        const finish = (result) => {
          worker?.terminate();
          resolve(result);
        };
        try {
          worker = new globalThis.Worker(url);
          worker.onmessage = () => finish('ran');
          worker.onerror = (event) => {
            event.preventDefault();
            finish('blocked');
          };
        } catch {
          finish('blocked');
        }
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  });
  assert.equal(blobWorker, tight ? 'blocked' : 'ran');
  report.blobWorker = blobWorker;
  await wallet.evaluate(() => {
    const probe = globalThis.document.createElement('div');
    probe.style.cssText =
      'width: 10px; height: 10px; background-image: url(https://css.example/synthetic.svg)';
    globalThis.document.body.append(probe);
  });
  await delay(200);
  if (tight)
    assert.ok(
      report.violations.some(
        (event) =>
          event.directive === 'img-src' && event.blocked === 'https://css.example/synthetic.svg',
      ),
    );
  const documentUrl = wallet.url();
  await wallet.evaluate(() => {
    globalThis.open('https://escape.example/synthetic', '_blank');
    globalThis.open('https://github.com/synthetic?probe=public-fixture', '_blank');
    globalThis.location.href = 'https://escape.example/navigation';
  });
  await delay(500);
  assert.equal(wallet.url(), documentUrl);
  const external = await app.evaluate(() => globalThis.cspExternal);
  assert.deepEqual(external, ['https://github.com/synthetic?probe=public-fixture']);
  report.external = external;
  report.checks.push(
    'Navigation and window creation blocked; allowed external URL handed to intercepted OS opener',
  );
  report.permission = await wallet.evaluate(
    async () => (await navigator.permissions.query({ name: 'geolocation' })).state,
  );
  assert.equal(report.permission, 'denied');
  await snapshot('channel-probes', false);
  assert.equal(
    report.servedImages.includes(imageUrl),
    !tight,
    'The HTTPS NFT request reaches the intercepted network only with the old CSP',
  );
  if (tight)
    assert.ok(report.servedImages.every((url) => new URL(url).origin === 'https://qrlwallet.com'));
  report.result = 'PASS';
} catch (error) {
  report.result = 'FAIL';
  report.error = error.stack;
  console.error(error);
  if (wallet) {
    // Recovery screens can contain ephemeral secrets; keep failure output to
    // request metadata and the assertion, with no DOM dump or screenshot.
    console.log(`Failed screen: ${screen}`);
    if (screen === 'startup') {
      console.log(await wallet.locator('body').innerText());
      await wallet.screenshot({ path: path.join(evidence, 'startup-failure.png') });
    }
  }
  process.exitCode = 1;
} finally {
  if (app) await app.close();
  await writeFile(path.join(evidence, 'inventory.json'), JSON.stringify(report, null, 2) + '\n');
  await rm(profile, { recursive: true, force: true });
  console.log(`Evidence: ${evidence}`);
}
