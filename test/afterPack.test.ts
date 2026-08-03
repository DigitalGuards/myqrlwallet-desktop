import { createRequire } from 'node:module';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

interface AfterPackModule {
  resolveElectronBinary: (
    platform: string,
    appOutDir: string,
    productFilename: string,
    linuxExecutableName?: string,
  ) => string;
}

const require = createRequire(import.meta.url);
const { resolveElectronBinary } = require('../scripts/afterPack.cjs') as AfterPackModule;

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
