import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { FuseState, FuseV1Options, FuseVersion, getCurrentFuseWire } from '@electron/fuses';
import { isRecord } from '../src/shared/guards';

interface AfterPackModule {
  default: (context: {
    appOutDir: string;
    electronPlatformName: string;
    packager: {
      appInfo: { productFilename: string };
      executableName: string;
    };
  }) => Promise<void>;
  resolveElectronBinary: (
    platform: string,
    appOutDir: string,
    productFilename: string,
    linuxExecutableName?: string,
  ) => string;
}

const require = createRequire(import.meta.url);
const afterPack: unknown = require('../scripts/afterPack.cjs');
function isAfterPackModule(value: unknown): value is AfterPackModule {
  return (
    isRecord(value) &&
    typeof value['default'] === 'function' &&
    typeof value['resolveElectronBinary'] === 'function'
  );
}
assert.ok(isAfterPackModule(afterPack));
const { resolveElectronBinary } = afterPack;

test('afterPack resolves the Linux executable name independently from the product name', () => {
  assert.equal(
    resolveElectronBinary('linux', '/tmp/app', 'MyQRLWallet', 'myqrlwallet-desktop'),
    join('/tmp/app', 'myqrlwallet-desktop'),
  );
});

test('afterPack preserves the platform bundle conventions on macOS and Windows', () => {
  assert.equal(
    resolveElectronBinary('darwin', '/tmp/app', 'MyQRLWallet', 'ignored'),
    join('/tmp/app', 'MyQRLWallet.app', 'Contents', 'MacOS', 'MyQRLWallet'),
  );
  assert.equal(
    resolveElectronBinary('win32', '/tmp/app', 'MyQRLWallet', 'ignored'),
    join('/tmp/app', 'MyQRLWallet.exe'),
  );
});

// The upstream V1 binary wire: sentinel, version byte, length byte, state bytes.
// Exercise the real hook and fuse library without launching an Electron process.
async function fuseFixture(t: TestContext, extraFuse = false) {
  const appOutDir = await mkdtemp(join(tmpdir(), 'desktop-fuses-'));
  t.after(() => rm(appOutDir, { recursive: true, force: true }));
  const executableName = 'myqrlwallet-desktop';
  const binary = join(appOutDir, executableName);
  const states = [
    FuseState.ENABLE,
    FuseState.DISABLE,
    FuseState.ENABLE,
    FuseState.ENABLE,
    FuseState.DISABLE,
    FuseState.DISABLE,
    FuseState.DISABLE,
    FuseState.ENABLE,
    FuseState.ENABLE,
  ];
  if (extraFuse) states.push(FuseState.ENABLE);
  const bytes = Buffer.concat([
    Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'),
    Buffer.from([1, states.length, ...states]),
  ]);
  await writeFile(binary, bytes);
  return {
    binary,
    bytes,
    context: {
      appOutDir,
      electronPlatformName: 'linux',
      packager: { appInfo: { productFilename: 'MyQRLWallet' }, executableName },
    },
  };
}

test('afterPack enforces all nine Electron 44 fuses on the packaged binary', async (t) => {
  const fixture = await fuseFixture(t);
  await afterPack.default(fixture.context);
  assert.deepEqual(await getCurrentFuseWire(fixture.binary), {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: FuseState.DISABLE,
    [FuseV1Options.EnableCookieEncryption]: FuseState.ENABLE,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: FuseState.DISABLE,
    [FuseV1Options.EnableNodeCliInspectArguments]: FuseState.DISABLE,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: FuseState.ENABLE,
    [FuseV1Options.OnlyLoadAppFromAsar]: FuseState.ENABLE,
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: FuseState.DISABLE,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: FuseState.DISABLE,
    [FuseV1Options.WasmTrapHandlers]: FuseState.ENABLE,
  });
});

test('afterPack rejects an unreviewed fuse without partially modifying the binary', async (t) => {
  const fixture = await fuseFixture(t, true);
  await assert.rejects(afterPack.default(fixture.context), /strictlyRequireAllFuses/);
  assert.deepEqual(await readFile(fixture.binary), fixture.bytes);
});
