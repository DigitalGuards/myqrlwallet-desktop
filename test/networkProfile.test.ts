/**
 * Build-time network profiles (src/main/config.ts NETWORKS).
 *
 * The testnet row must keep every value existing installs run on. The mainnet
 * row is dormant: with null pins it refuses to build and to start, and RPC and
 * signing refuse before any request. A pinned mainnet row is exercised through
 * an injected table, so the real table keeps its null pins.
 *
 * config.ts selects the build's network when it is imported, so the
 * selection cases run in fresh tsx children, like test/config.rpc.test.ts.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  NETWORKS,
  NetworkProfileError,
  nativeNetworkCapability,
  networkBuildDefines,
  networkProfileName,
  rendererNetworkValues,
  resolveNetwork,
  type NetworkProfileName,
  type NetworkTableEntry,
} from '../src/main/config';
import { startupNetwork } from '../src/main/startupNetwork';
import { isRecord } from '../src/shared/guards';

const TESTNET_GENESIS = '0xd15407991193e6c23b733dc6bf9c628deaff8f9b6e252aa0d60030952b3e3ea4';
const TESTNET_QNS =
  'Qcfc5f3242cE7d413F308D4181fd45D441d535298d78fd2d26833c2650408f636B46590dc10D23221480eFac958705Ba6C266eEB16B5aeafA64202715Adc84424';
const MAINNET_GENESIS = `0x${'ab'.repeat(32)}`;
const ADDRESS = `Q${'ab'.repeat(64)}`;

type Table = Readonly<Record<NetworkProfileName, NetworkTableEntry>>;

function withMainnet(changes: Partial<NetworkTableEntry>): Table {
  return { ...NETWORKS, mainnet: { ...NETWORKS.mainnet, ...changes } };
}

const PINNED_MAINNET = withMainnet({ chainId: 7, genesisHash: MAINNET_GENESIS });

test('the testnet row keeps the values every existing install runs on', () => {
  assert.deepEqual(NETWORKS.testnet, {
    networkProfile: 'v3-private',
    userDataDir: 'v3-private',
    chainId: 3151909,
    genesisHash: TESTNET_GENESIS,
    rpcPath: 'testnet',
    rpcUrl: 'https://qrlwallet.com/api/qrl-rpc/testnet',
    rpcUrlSecondary: 'https://dev.qrlwallet.com/api/qrl-rpc/testnet',
    qnsRegistry: TESTNET_QNS,
  });
  assert.ok(Object.isFrozen(NETWORKS) && Object.isFrozen(NETWORKS.testnet));
});

test('the mainnet row is dormant: no pins, the mainnet proxy, no failover, its own directory', () => {
  assert.deepEqual(NETWORKS.mainnet, {
    networkProfile: 'v3-mainnet',
    userDataDir: 'v3-mainnet',
    chainId: null,
    genesisHash: null,
    rpcPath: 'mainnet',
    rpcUrl: 'https://qrlwallet.com/api/qrl-rpc/mainnet',
    rpcUrlSecondary: null,
    qnsRegistry: '',
  });
  assert.ok(Object.isFrozen(NETWORKS.mainnet));
});

test('an unset or empty profile selects testnet and an unknown one is refused', () => {
  assert.equal(networkProfileName(undefined), 'testnet');
  assert.equal(networkProfileName(''), 'testnet');
  assert.equal(networkProfileName('testnet'), 'testnet');
  assert.equal(networkProfileName('mainnet'), 'mainnet');
  for (const value of ['Mainnet', ' testnet', 'v3-private', 'mainnet-beta', 1]) {
    assert.throws(() => networkProfileName(value), NetworkProfileError);
  }
});

test('the default build is testnet and advertises v3-private with the testnet pins', () => {
  const network = resolveNetwork(undefined);
  assert.equal(network.profile, 'testnet');
  assert.equal(network.userDataDir, 'v3-private');
  assert.deepEqual(nativeNetworkCapability(network), {
    networkProfile: 'v3-private',
    chainId: '0x301825',
    genesisHash: TESTNET_GENESIS,
  });
  assert.deepEqual(networkBuildDefines(undefined), {
    __QRL_NETWORK_PROFILE__: '"testnet"',
    __QRL_WALLET_NETWORK__: JSON.stringify({
      networkProfile: 'v3-private',
      chainId: '0x301825',
      genesisHash: TESTNET_GENESIS,
    }),
  });
  assert.deepEqual(networkBuildDefines('testnet'), networkBuildDefines(undefined));
});

test('a mainnet profile with null pins refuses to build', () => {
  const message = /mainnet network has no pinned chain id and genesis hash/;
  assert.throws(() => resolveNetwork('mainnet'), message);
  assert.throws(() => networkBuildDefines('mainnet'), message);
  assert.throws(() => rendererNetworkValues('mainnet'), message);
  assert.throws(() => resolveNetwork('mainnet'), NetworkProfileError);
});

test('a pinned mainnet row selects its own pins, capability profile and data directory', () => {
  const network = resolveNetwork('mainnet', PINNED_MAINNET);
  assert.equal(network.profile, 'mainnet');
  assert.equal(network.chainId, 7);
  assert.equal(network.genesisHash, MAINNET_GENESIS);
  assert.equal(network.userDataDir, 'v3-mainnet');
  assert.equal(network.rpcUrl, 'https://qrlwallet.com/api/qrl-rpc/mainnet');
  assert.equal(network.rpcUrlSecondary, null);
  assert.deepEqual(nativeNetworkCapability(network), {
    networkProfile: 'v3-mainnet',
    chainId: '0x7',
    genesisHash: MAINNET_GENESIS,
  });
  // The testnet row of the same table is untouched.
  assert.equal(resolveNetwork('testnet', PINNED_MAINNET).userDataDir, 'v3-private');
  assert.deepEqual(rendererNetworkValues('mainnet', PINNED_MAINNET), [
    ['NETWORK_PROFILE', 'mainnet'],
    ['TESTNET_CHAIN_ID', '0x301825'],
    ['TESTNET_GENESIS_HASH', TESTNET_GENESIS],
    ['TESTNET_RPC_PATH', 'testnet'],
    ['TESTNET_QNS_REGISTRY', TESTNET_QNS],
    ['MAINNET_CHAIN_ID', '0x7'],
    ['MAINNET_GENESIS_HASH', MAINNET_GENESIS],
    ['MAINNET_RPC_PATH', 'mainnet'],
    ['MAINNET_QNS_REGISTRY', ''],
  ]);
  assert.deepEqual(rendererNetworkValues(undefined, PINNED_MAINNET), [
    ['NETWORK_PROFILE', 'testnet'],
    ['TESTNET_CHAIN_ID', '0x301825'],
    ['TESTNET_GENESIS_HASH', TESTNET_GENESIS],
    ['TESTNET_RPC_PATH', 'testnet'],
    ['TESTNET_QNS_REGISTRY', TESTNET_QNS],
  ]);
});

test('a mainnet identity must be complete, well formed and differ from testnet', () => {
  const refused: [string, Table, RegExp][] = [
    ['chain id alone', withMainnet({ chainId: 7 }), /needs both a chain id and a genesis hash/],
    [
      'genesis alone',
      withMainnet({ genesisHash: MAINNET_GENESIS }),
      /needs both a chain id and a genesis hash/,
    ],
    [
      'testnet chain id',
      withMainnet({ chainId: 3151909, genesisHash: MAINNET_GENESIS }),
      /identity must differ from testnet/,
    ],
    [
      'testnet genesis',
      withMainnet({ chainId: 7, genesisHash: TESTNET_GENESIS }),
      /identity must differ from testnet/,
    ],
    ['zero chain id', withMainnet({ chainId: 0, genesisHash: MAINNET_GENESIS }), /positive/],
    [
      'fractional chain id',
      withMainnet({ chainId: 1.5, genesisHash: MAINNET_GENESIS }),
      /positive/,
    ],
    [
      'uppercase genesis',
      withMainnet({ chainId: 7, genesisHash: MAINNET_GENESIS.toUpperCase() }),
      /genesis hash/,
    ],
    ['short genesis', withMainnet({ chainId: 7, genesisHash: '0xab' }), /genesis hash/],
    [
      'testnet endpoint',
      withMainnet({
        chainId: 7,
        genesisHash: MAINNET_GENESIS,
        rpcPath: 'testnet',
        rpcUrl: 'https://qrlwallet.com/api/qrl-rpc/testnet',
      }),
      /RPC endpoints must differ from testnet/,
    ],
    [
      'testnet failover endpoint',
      withMainnet({
        chainId: 7,
        genesisHash: MAINNET_GENESIS,
        rpcUrlSecondary: 'https://dev.qrlwallet.com/api/qrl-rpc/testnet',
      }),
      /RPC endpoints must differ from testnet/,
    ],
    [
      'endpoint outside its path',
      withMainnet({ chainId: 7, genesisHash: MAINNET_GENESIS, rpcUrl: 'https://rpc.example/' }),
      /must end with \/mainnet/,
    ],
    [
      'shared data directory',
      withMainnet({ chainId: 7, genesisHash: MAINNET_GENESIS, userDataDir: 'v3-private' }),
      /data directory must differ from testnet/,
    ],
    [
      'testnet capability profile',
      withMainnet({ chainId: 7, genesisHash: MAINNET_GENESIS, networkProfile: 'v3-private' }),
      /data directory must differ from testnet/,
    ],
    [
      'malformed QNS registry',
      withMainnet({ chainId: 7, genesisHash: MAINNET_GENESIS, qnsRegistry: '0x1234' }),
      /QNS registry/,
    ],
  ];
  for (const [name, table, message] of refused) {
    assert.throws(() => resolveNetwork('mainnet', table), message, name);
    assert.throws(() => resolveNetwork('mainnet', table), NetworkProfileError, name);
  }
});

const CONFIG = JSON.stringify(new URL('../src/main/config.ts', import.meta.url).href);
const RPC = JSON.stringify(new URL('../src/main/rpc.ts', import.meta.url).href);
const SIGNATURE = JSON.stringify(new URL('../src/main/signatureRequest.ts', import.meta.url).href);

/** Runs `body` as a module in a fresh tsx child and parses the JSON it prints. */
function inChild(profile: string | undefined, body: string): Record<string, unknown> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env['QRL_NETWORK_PROFILE'];
  delete env['QRL_RPC_URL'];
  delete env['QRL_RPC_URL_SECONDARY'];
  if (profile !== undefined) env['QRL_NETWORK_PROFILE'] = profile;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module'], {
    input: body,
    encoding: 'utf8',
    env,
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed: unknown = JSON.parse(result.stdout);
  assert.ok(isRecord(parsed));
  return parsed;
}

const SELECTION = `const c = await import(${CONFIG});
let network = null;
let refused = null;
try {
  const n = c.pinnedNetwork();
  network = { profile: n.profile, userDataDir: n.userDataDir, networkProfile: n.networkProfile, chainId: n.chainId, genesisHash: n.genesisHash };
} catch (err) {
  refused = err instanceof c.NetworkProfileError ? err.message : 'unexpected ' + String(err);
}
process.stdout.write(JSON.stringify({ network, refused, primary: c.RPC_URL, secondary: c.RPC_URL_SECONDARY ?? null }));`;

test('the default build keeps the testnet pins and the v3-private data directory', () => {
  for (const profile of [undefined, '', 'testnet']) {
    assert.deepEqual(inChild(profile, SELECTION), {
      network: {
        profile: 'testnet',
        userDataDir: 'v3-private',
        networkProfile: 'v3-private',
        chainId: 3151909,
        genesisHash: TESTNET_GENESIS,
      },
      refused: null,
      primary: 'https://qrlwallet.com/api/qrl-rpc/testnet',
      secondary: 'https://dev.qrlwallet.com/api/qrl-rpc/testnet',
    });
  }
});

test('an unpinned mainnet build loads its configuration but has no network to run on', () => {
  assert.deepEqual(inChild('mainnet', SELECTION), {
    network: null,
    refused:
      'The mainnet network has no pinned chain id and genesis hash yet, so this build cannot run on it.',
    primary: 'https://qrlwallet.com/api/qrl-rpc/mainnet',
    secondary: null,
  });
  const unknown = inChild('mainnet-beta', SELECTION);
  assert.equal(unknown['network'], null);
  assert.equal(unknown['refused'], 'QRL_NETWORK_PROFILE must be testnet or mainnet');
});

test('the build-time profile wins over the launch environment', () => {
  const defined = (profile: string): string =>
    `globalThis.__QRL_NETWORK_PROFILE__ = ${JSON.stringify(profile)};\n${SELECTION}`;
  const testnet = inChild('mainnet', defined('testnet'));
  assert.ok(isRecord(testnet['network']));
  assert.equal(testnet['network']['profile'], 'testnet');
  assert.equal(testnet['network']['userDataDir'], 'v3-private');
  const mainnet = inChild('testnet', defined('mainnet'));
  assert.equal(mainnet['network'], null);
  assert.match(String(mainnet['refused']), /no pinned chain id and genesis hash/);
});

test('an unpinned mainnet build refuses RPC and signing before any request', () => {
  const result = inChild(
    'mainnet',
    `const c = await import(${CONFIG});
let fetches = 0;
globalThis.fetch = () => {
  fetches += 1;
  return Promise.reject(new Error('unexpected network access'));
};
const rpc = await import(${RPC});
const outcome = async (call) => {
  try {
    await call();
    return 'completed';
  } catch (err) {
    return err instanceof c.NetworkProfileError ? 'refused' : 'unexpected ' + String(err);
  }
};
const rpcCalls = [
  await outcome(() => rpc.getBalance(${JSON.stringify(ADDRESS)})),
  await outcome(() => rpc.getChainId()),
  await outcome(() => rpc.sendRawTransaction('0x02')),
];
const { signWithConfirmation } = await import(${SIGNATURE});
const steps = [];
const signing = await outcome(() =>
  signWithConfirmation(
    { kind: 'message', signer: ${JSON.stringify(ADDRESS)}, messageHex: '0x6869' },
    {
      signer: {
        status: async () => {
          steps.push('status');
          return { unlocked: true, address: ${JSON.stringify(ADDRESS)}, unlockExpiresAt: null };
        },
        sign: async () => {
          steps.push('sign');
          return {};
        },
      },
      confirm: async () => {
        steps.push('confirm');
        return true;
      },
    },
  ),
);
process.stdout.write(JSON.stringify({ rpcCalls, fetches, signing, steps }));`,
  );
  assert.deepEqual(result, {
    rpcCalls: ['refused', 'refused', 'refused'],
    fetches: 0,
    signing: 'refused',
    steps: [],
  });
});

test('signer pins follow the selected profile', () => {
  const result = inChild(
    'testnet',
    `const { signWithConfirmation } = await import(${SIGNATURE});
globalThis.fetch = () => Promise.reject(new Error('offline signing reached the network'));
const seen = {};
await signWithConfirmation(
  { kind: 'message', signer: ${JSON.stringify(ADDRESS)}, messageHex: '0x6869' },
  {
    signer: {
      status: async () => ({ unlocked: true, address: ${JSON.stringify(ADDRESS)}, unlockExpiresAt: null }),
      sign: async (_request, chainId) => {
        seen.signerChainId = chainId;
        return {};
      },
    },
    confirm: async (_request, context) => {
      seen.confirmChainId = context.connectedChainId;
      return true;
    },
  },
);
process.stdout.write(JSON.stringify(seen));`,
  );
  assert.deepEqual(result, { signerChainId: 3151909, confirmChainId: 3151909 });
});

test('startup refuses an unpinned network with an error box and exit code 1', () => {
  const calls: string[] = [];
  const refusal = {
    showErrorBox: (title: string, content: string) => calls.push(`box:${title}:${content}`),
    exit: (code: number) => calls.push(`exit:${String(code)}`),
    log: (message: string) => calls.push(`log:${message}`),
    title: 'MyQRLWallet failed to start',
  };
  const message = 'The mainnet network has no pinned chain id and genesis hash yet.';
  assert.throws(
    () =>
      startupNetwork(() => {
        throw new NetworkProfileError(message);
      }, refusal),
    NetworkProfileError,
  );
  assert.deepEqual(calls, [
    `log:[boot] refused to start: ${message}`,
    `box:MyQRLWallet failed to start:${message}`,
    'exit:1',
  ]);

  calls.length = 0;
  const testnet = resolveNetwork('testnet');
  assert.equal(
    startupNetwork(() => testnet, refusal),
    testnet,
  );
  assert.deepEqual(calls, []);
});

test('main checks the network before anything it registers, creates or starts', async () => {
  const source = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8');
  const gate = source.indexOf('const NETWORK = startupNetwork(pinnedNetwork,');
  assert.ok(gate > 0, 'index.ts gates startup on the pinned network');
  for (const later of [
    'protocol.registerSchemesAsPrivileged(',
    'new SignerBridge(',
    'new DappUriIngress(',
    "app.setName('MyQRLWallet')",
    'mkdirSync(currentUserData',
    "app.setPath('userData'",
    'app.requestSingleInstanceLock()',
    'registerQrlconnectProtocol();',
    '.whenReady()',
  ]) {
    const at = source.indexOf(later);
    assert.ok(at > gate, `${later} runs after the network gate`);
  }
  // The only statements above the gate are imports.
  const preamble = source
    .slice(0, gate)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(preamble.replace(/^import[\s\S]*?;$/gm, ''), /\S/);
  // The data directory is the table's, so testnet keeps v3-private.
  assert.match(source, /path\.join\(legacyUserData, NETWORK\.userDataDir\)/);
  assert.doesNotMatch(source, /'v3-private'/);
});

test('electron-vite refuses an unpinned mainnet build before building anything', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const result = spawnSync(
    process.execPath,
    ['node_modules/electron-vite/bin/electron-vite.js', 'build'],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, QRL_NETWORK_PROFILE: 'mainnet' },
      timeout: 120_000,
    },
  );
  assert.equal(result.status, 1);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.match(output, /mainnet network has no pinned chain id and genesis hash/);
  assert.doesNotMatch(output, /building/i);
});
