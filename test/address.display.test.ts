import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatQrlAddressFingerprint, groupQrlAddress } from '../src/shared/address';

const Q128 = `Q${'11111111'}${'2'.repeat(52)}${'33333333'}${'4'.repeat(52)}${'55555555'}`;
const Q40 = `Q${'11111111'}${'2'.repeat(8)}${'33333333'}${'4'.repeat(8)}${'55555555'}`;

test('address fingerprint shows the first, middle, and final 8 hex characters', () => {
  assert.equal(formatQrlAddressFingerprint(Q128), 'Q11111111...33333333...55555555');
  assert.equal(formatQrlAddressFingerprint(Q40), 'Q11111111...33333333...55555555');
});

test('address fingerprint preserves checksum case', () => {
  const address = `QaBcDeF01${'2'.repeat(52)}AbCdEf09${'4'.repeat(52)}FfEeDdCc`;
  assert.equal(formatQrlAddressFingerprint(address), 'QaBcDeF01...AbCdEf09...FfEeDdCc');
});

test('invalid, short, and unsupported-width values remain unchanged', () => {
  for (const address of [
    '',
    'not-an-address',
    'Q1234',
    `q${'1'.repeat(128)}`,
    `Q${'1'.repeat(127)}`,
    `Q${'1'.repeat(129)}`,
  ]) {
    assert.equal(formatQrlAddressFingerprint(address), address);
    assert.equal(groupQrlAddress(address), address);
  }
});

test('full review grouping preserves every address character', () => {
  const grouped = groupQrlAddress(Q128);
  assert.equal(grouped.replaceAll(' ', ''), Q128);
  assert.equal(
    grouped,
    `Q${Q128.slice(1)
      .match(/.{1,8}/g)
      ?.join(' ')}`,
  );
});

import { toChecksumAddress } from '@theqrl/wallet.js';
import { assertValidQrlAddressCase, hasValidQrlAddressCase } from '../src/signer/addressCase';

test('uniform-case bodies pass the QIP-55 case rule', () => {
  const lower = `Q${'ab'.repeat(64)}`;
  assert.equal(hasValidQrlAddressCase(lower), true);
  assert.equal(hasValidQrlAddressCase(`Q${'AB'.repeat(64)}`), true);
});

test('only the exact checksummed mixed-case body passes the signer gate', () => {
  const canonical = toChecksumAddress(`Q${'ab'.repeat(64)}`);
  assert.equal(hasValidQrlAddressCase(canonical), true);
  const body = canonical.slice(1);
  const letterIndex = body.split('').findIndex((c) => /[a-fA-F]/.test(c));
  assert.ok(letterIndex >= 0);
  const original = body.charAt(letterIndex);
  const swapped =
    original === original.toLowerCase() ? original.toUpperCase() : original.toLowerCase();
  const flipped = `Q${body.slice(0, letterIndex)}${swapped}${body.slice(letterIndex + 1)}`;
  assert.notEqual(flipped, canonical);
  assert.equal(hasValidQrlAddressCase(flipped), false);
  assert.throws(() => assertValidQrlAddressCase(flipped, 'recipient'), /checksum casing/);
});
