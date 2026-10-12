import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LedgerError, encodeQrlPath, parseQrlPath, qrlAccountPath } from '../src/ledger';
import { toHex } from '../src/ledger/bytes';
import { loadFixture } from './ledgerFixtures';

const H = 0x80000000;

test('parses the canonical QRL path', () => {
  assert.deepEqual(parseQrlPath("m/44'/238'/0'/0/0"), [H + 44, H + 238, H, 0, 0]);
  assert.deepEqual(parseQrlPath("m/44'/238'/7'/1/42"), [H + 44, H + 238, H + 7, 1, 42]);
});

test('encodes the path exactly as the recorded address request carries it', () => {
  const identity = loadFixture('theqrl-nanosp-identity.json');
  const deriveApdu = identity.exchanges[3]?.apdu ?? '';
  assert.equal(deriveApdu.slice(10), toHex(encodeQrlPath("m/44'/238'/0'/0/0")));
  assert.equal(
    toHex(encodeQrlPath("m/44'/238'/0'/0/0")),
    '058000002c800000ee800000000000000000000000',
  );
});

test('builds account paths', () => {
  assert.equal(qrlAccountPath(3), "m/44'/238'/0'/0/3");
  assert.equal(qrlAccountPath(0, 2), "m/44'/238'/2'/0/0");
  assert.throws(() => qrlAccountPath(-1), LedgerError);
});

test('rejects every path the app refuses', () => {
  for (const path of [
    "m/44'/60'/0'/0/0",
    "m/49'/238'/0'/0/0",
    "m/44'/238'/0/0/0",
    "m/44'/238'/0'/0'/0",
    "m/44'/238'/0'/0/0'",
    "m/44'/238'/0'/0",
    "m/44'/238'/0'/0/0/0",
    "44'/238'/0'/0/0",
    "m/44'/238'/00'/0/0",
    'm/44h/238h/0h/0/0',
    "m/44'/238'/0'/0/2147483648",
    "m/44'/238'/ 0'/0/0",
    '',
  ]) {
    assert.throws(
      () => parseQrlPath(path),
      (error: unknown) => error instanceof LedgerError && error.code === 'invalid-path',
      path,
    );
  }
});
