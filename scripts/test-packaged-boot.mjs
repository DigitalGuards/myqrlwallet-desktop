// Usage: env -u DISPLAY -u WAYLAND_DISPLAY xvfb-run -a node scripts/test-packaged-boot.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses';
import { electronTestArgs, isolatedEnvironment, waitForAppPage } from './electron-test-utils.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const executable =
  process.env.QRL_PACKAGED_EXECUTABLE ??
  path.join(root, 'release/linux-unpacked/myqrlwallet-desktop');
assert.ok(process.env.QRL_FRONTEND_DIR, 'Set QRL_FRONTEND_DIR for Playwright');
const { _electron, chromium } = createRequire(
  path.join(process.env.QRL_FRONTEND_DIR, 'package.json'),
)('playwright');
const evidence = await mkdtemp(path.join(tmpdir(), 'desktop-packaged-boot-'));
const profile = path.join(evidence, 'profile');
const env = await isolatedEnvironment(profile);
const userData = path.join(profile, 'user-data/v3-private');
let setup;
let child;
let browser;
let output = '';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  const fuses = await getCurrentFuseWire(executable);
  assert.equal(fuses[FuseV1Options.GrantFileProtocolExtraPrivileges], FuseState.DISABLE);
  assert.equal(fuses[FuseV1Options.RunAsNode], FuseState.DISABLE);
  assert.equal(fuses[FuseV1Options.EnableNodeCliInspectArguments], FuseState.DISABLE);
  assert.equal(fuses[FuseV1Options.OnlyLoadAppFromAsar], FuseState.ENABLE);
  assert.equal(fuses[FuseV1Options.EnableEmbeddedAsarIntegrityValidation], FuseState.ENABLE);
  await writeFile(path.join(evidence, 'fuses.json'), JSON.stringify(fuses, null, 2));
  // Public deterministic fixture; no live RPC or transaction is needed for unlock.
  await mkdir(userData, { recursive: true });
  await writeFile(
    path.join(userData, 'settings.json'),
    JSON.stringify({ v: 1, walletOriginMigrationV1: true }),
  );
  setup = await _electron.launch({
    chromiumSandbox: true,
    executablePath: path.join(root, 'node_modules/electron/dist/electron'),
    args: [
      ...electronTestArgs(root),
      `--user-data-dir=${path.join(profile, 'user-data')}`,
      '--host-resolver-rules=MAP * ~NOTFOUND',
    ],
    env,
    timeout: 60000,
  });
  await setup.context().route(/^https?:/, (route) => route.abort());
  const wallet = await waitForAppPage(setup);
  await wallet.evaluate(() =>
    globalThis.qrlWallet.importWallet({
      hexSeed: '010000' + '01'.repeat(48),
      password: 'PackagedBootFixture!123',
      useKeychain: false,
    }),
  );
  await setup.close();
  setup = undefined;
  const settings = JSON.parse(await readFile(path.join(userData, 'settings.json'), 'utf8'));
  delete settings.walletOriginMigrationV1;
  await writeFile(path.join(userData, 'settings.json'), JSON.stringify(settings));
  // Keep every release fuse intact. Chromium's test port is independent of Node inspection.
  child = spawn(
    executable,
    [
      `--user-data-dir=${path.join(profile, 'user-data')}`,
      '--host-resolver-rules=MAP * ~NOTFOUND',
      '--remote-debugging-port=0',
    ],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout.on('data', (data) => {
    output += String(data);
  });
  child.stderr.on('data', (data) => {
    output += String(data);
  });
  const deadline = Date.now() + 45000;
  let endpoint;
  while (Date.now() < deadline && child.exitCode === null) {
    endpoint = /DevTools listening on (ws:\/\/[^\s]+)/.exec(output)?.[1];
    if (endpoint) break;
    await delay(100);
  }
  // Attach only after startup, so CDP cannot race the private helper preloads.
  while (Date.now() < deadline && child.exitCode === null) {
    const log = await readFile(path.join(userData, 'logs/main.log'), 'utf8').catch(() => '');
    assert.equal(log.includes('startup FAILED'), false, 'packaged startup succeeds');
    if (
      log.includes('[storage] wallet origin migration complete') &&
      log.includes('[ingress] renderer loaded')
    )
      break;
    await delay(100);
  }
  if (endpoint) browser = await chromium.connectOverCDP(endpoint);
  let unlock;
  while (Date.now() < deadline && child.exitCode === null) {
    unlock = browser
      ?.contexts()
      .flatMap((context) => context.pages())
      .find((page) => page.url() === 'app://unlock/index.html');
    if (unlock) break;
    await delay(100);
  }
  if (unlock) {
    await unlock.locator('input[type="password"]').waitFor({ state: 'visible' });
    await unlock.getByRole('button', { name: 'Unlock', exact: true }).waitFor();
    await unlock.screenshot({ path: path.join(evidence, 'unlock.png') });
    console.log('Packaged Linux unlock form visible at app://unlock/index.html');
  } else {
    // Packaged webPreferences can hide targets from CDP. Keep a native screenshot for review.
    const windows = execFileSync(
      'xdotool',
      ['search', '--onlyvisible', '--name', 'Unlock MyQRLWallet'],
      { env, encoding: 'utf8' },
    )
      .trim()
      .split('\n');
    assert.ok(windows[0]);
    execFileSync('import', ['-window', windows[0], path.join(evidence, 'unlock.png')], { env });
    console.log('Packaged Linux unlock window visible; review the native screenshot');
  }
  assert.equal(child.exitCode, null);
  const log = await readFile(path.join(userData, 'logs/main.log'), 'utf8');
  assert.match(log, /packaged=true/);
  assert.equal(log.includes('startup FAILED'), false);
  assert.equal(
    JSON.parse(await readFile(path.join(userData, 'settings.json'), 'utf8'))
      .walletOriginMigrationV1,
    true,
  );
  await writeFile(path.join(evidence, 'boot.log'), output);
  console.log('Release fuses intact; storage helper completed with file privileges disabled');
  console.log(`Evidence: ${evidence}`);
} finally {
  await setup?.close();
  await browser?.close();
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await Promise.race([exited, delay(5000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  await writeFile(path.join(evidence, 'boot.log'), output);
  await writeFile(
    path.join(evidence, 'main.log'),
    await readFile(path.join(userData, 'logs/main.log'), 'utf8').catch(() => 'No main log'),
  );
  console.log(`Evidence: ${evidence}`);
  await rm(profile, { recursive: true, force: true });
}
