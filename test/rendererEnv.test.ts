/**
 * The renderer build environment scripts/build-renderer.sh derives, printed by
 * its `--print-env` mode. The testnet values below are written out by hand and
 * equal what the script produced before network profiles existed (desktop
 * 1.4.8), so a testnet build bundles a byte-identical renderer configuration.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

const SCRIPT = resolve('scripts/build-renderer.sh');
const GENESIS = '0xd15407991193e6c23b733dc6bf9c628deaff8f9b6e252aa0d60030952b3e3ea4';
const QNS =
  'Qcfc5f3242cE7d413F308D4181fd45D441d535298d78fd2d26833c2650408f636B46590dc10D23221480eFac958705Ba6C266eEB16B5aeafA64202715Adc84424';

const csp = (backend: string): string =>
  `DESKTOP_CSP=default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://${backend} wss://${backend} https://qrlwallet.com wss://qrlwallet.com https://zondscan.com; img-src 'self' data: https://${backend}; media-src 'self' blob:; font-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'; worker-src 'self'`;

/** Desktop 1.4.8's renderer environment for a default (production) build. */
const TESTNET_PRODUCTION = [
  'VITE_DESKTOP=1',
  'VITE_EXPLORER_URL_DEVELOPMENT=https://zondscan.com',
  'VITE_EXPLORER_URL_PRODUCTION=https://zondscan.com',
  'VITE_NODE_ENV=production',
  'VITE_RPC_URL_DEVELOPMENT=https://dev.qrlwallet.com/api/qrl-rpc',
  'VITE_RPC_URL_PRODUCTION=https://qrlwallet.com/api/qrl-rpc',
  'VITE_SERVER_URL_DEVELOPMENT=https://dev.qrlwallet.com/api',
  'VITE_SERVER_URL_PRODUCTION=https://qrlwallet.com/api',
  'VITE_V3_CHAIN_ID=0x301825',
  'VITE_V3_EXPLORER_URL=https://zondscan.com',
  `VITE_V3_GENESIS_HASH=${GENESIS}`,
  `VITE_V3_QNS_REGISTRY=${QNS}`,
  'VITE_V3_RPC_URL=https://qrlwallet.com/api/qrl-rpc/testnet',
  'VITE_V3_SERVER_URL=https://qrlwallet.com/api',
  'VITE_WALLET_PROFILE=v3-private',
  csp('qrlwallet.com'),
];

/** Desktop 1.4.8's renderer environment for a staging build. */
const TESTNET_DEVELOPMENT = TESTNET_PRODUCTION.map((line) => {
  if (line === 'VITE_NODE_ENV=production') return 'VITE_NODE_ENV=development';
  if (line.startsWith('VITE_V3_RPC_URL='))
    return 'VITE_V3_RPC_URL=https://dev.qrlwallet.com/api/qrl-rpc/testnet';
  if (line.startsWith('VITE_V3_SERVER_URL='))
    return 'VITE_V3_SERVER_URL=https://dev.qrlwallet.com/api';
  if (line.startsWith('DESKTOP_CSP=')) return csp('dev.qrlwallet.com');
  return line;
});

/** The caller's environment minus every VITE_* and QRL_* value. */
function scrubbedEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('VITE_') && !key.startsWith('QRL_')) env[key] = value;
  }
  return { ...env, ...extra };
}

function printEnv(script: string, extra: Record<string, string> = {}) {
  const result = spawnSync('bash', [script, '--print-env'], {
    encoding: 'utf8',
    env: scrubbedEnv(extra),
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    lines: result.stdout.split('\n').filter((line) => /^(?:VITE_|DESKTOP_CSP=)/.test(line)),
  };
}

test('the default testnet build keeps the desktop 1.4.8 renderer environment', () => {
  for (const extra of [{}, { QRL_NETWORK_PROFILE: '' }, { QRL_NETWORK_PROFILE: 'testnet' }]) {
    const result = printEnv(SCRIPT, extra);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.lines, TESTNET_PRODUCTION);
  }
});

test('a testnet staging build keeps the desktop 1.4.8 renderer environment', () => {
  const result = printEnv(SCRIPT, { VITE_NODE_ENV: 'development' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.lines, TESTNET_DEVELOPMENT);
});

test('an explicitly empty QNS registry still builds without name resolution', () => {
  const result = printEnv(SCRIPT, { VITE_V3_QNS_REGISTRY: '' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    result.lines,
    TESTNET_PRODUCTION.map((line) =>
      line.startsWith('VITE_V3_QNS_REGISTRY=') ? 'VITE_V3_QNS_REGISTRY=' : line,
    ),
  );
});

test('a mainnet build without pinned identity refuses to build', () => {
  const result = printEnv(SCRIPT, { QRL_NETWORK_PROFILE: 'mainnet' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /mainnet network has no pinned chain id and genesis hash/);
  assert.deepEqual(result.lines, []);
});

test('an unknown network profile refuses to build', () => {
  const result = printEnv(SCRIPT, { QRL_NETWORK_PROFILE: 'mainnet-beta' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /QRL_NETWORK_PROFILE must be testnet or mainnet/);
  assert.deepEqual(result.lines, []);
});

test('renderer pins come from the network table alone', () => {
  for (const extra of [
    { VITE_MAINNET_CHAIN_ID: '0x1' },
    { VITE_MAINNET_GENESIS_HASH: `0x${'ab'.repeat(32)}` },
    { VITE_V3_NATIVE_NETWORK: 'mainnet' },
  ]) {
    const result = printEnv(SCRIPT, extra);
    assert.equal(result.status, 1, JSON.stringify(extra));
    assert.deepEqual(result.lines, []);
  }
});

/**
 * The mainnet branch, exercised with a pinned mainnet row. The fixture's
 * scripts/network-values.mjs feeds the real rendererNetworkValues a table whose
 * mainnet row carries test pins; the real table keeps its null pins.
 */
function pinnedMainnetFixture(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'myqrlwallet-renderer-env-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, 'scripts'));
  const script = join(root, 'scripts/build-renderer.sh');
  copyFileSync(SCRIPT, script);
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'dir');
  const config = JSON.stringify(resolve('src/main/config.ts'));
  writeFileSync(
    join(root, 'scripts/network-values.mjs'),
    `import { NETWORKS, rendererNetworkValues } from ${config};
const table = { ...NETWORKS, mainnet: { ...NETWORKS.mainnet, chainId: 7, genesisHash: '0x${'ab'.repeat(32)}' } };
for (const [key, value] of rendererNetworkValues(process.env.QRL_NETWORK_PROFILE, table)) {
  process.stdout.write(key + '=' + value + '\\n');
}
`,
  );
  return script;
}

test('a pinned mainnet build lists only mainnet and keeps the testnet block', (t) => {
  const script = pinnedMainnetFixture(t);
  const result = printEnv(script, { QRL_NETWORK_PROFILE: 'mainnet' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    result.lines,
    [
      ...TESTNET_PRODUCTION.filter((line) => !line.startsWith('DESKTOP_CSP=')),
      'VITE_MAINNET_CHAIN_ID=0x7',
      'VITE_MAINNET_EXPLORER_URL=',
      `VITE_MAINNET_GENESIS_HASH=0x${'ab'.repeat(32)}`,
      'VITE_MAINNET_QNS_REGISTRY=',
      'VITE_MAINNET_RPC_URL=https://qrlwallet.com/api/qrl-rpc/mainnet',
      'VITE_MAINNET_SERVER_URL=https://qrlwallet.com/api',
      'VITE_V3_NATIVE_NETWORK=mainnet',
    ]
      .sort()
      .concat(csp('qrlwallet.com')),
  );

  // The same fixture with the default profile is the unchanged testnet build.
  const testnet = printEnv(script);
  assert.equal(testnet.status, 0, testnet.stderr);
  assert.deepEqual(testnet.lines, TESTNET_PRODUCTION);

  // A staging mainnet build reaches the dev backend's mainnet proxy.
  const staging = printEnv(script, {
    QRL_NETWORK_PROFILE: 'mainnet',
    VITE_NODE_ENV: 'development',
  });
  assert.equal(staging.status, 0, staging.stderr);
  assert.ok(
    staging.lines.includes('VITE_MAINNET_RPC_URL=https://dev.qrlwallet.com/api/qrl-rpc/mainnet'),
  );
  assert.ok(staging.lines.includes('VITE_MAINNET_SERVER_URL=https://dev.qrlwallet.com/api'));
});
