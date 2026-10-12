import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toChecksumAddress } from '@theqrl/wallet.js';
import { hasValidQrlAddressCase } from '../src/shared/addressCase';
import { SignatureRequestSchema } from '../src/shared/schemas';
import { computeTypedDataDigest } from '../src/signer/typedData';
import { payloadWith, SIGNER } from './typedDataFixtures';

test('shared public checksum validation matches wallet.js across every address nibble', () => {
  const lower = `Q${'abcdef01'.repeat(16)}`;
  const checked = toChecksumAddress(lower);
  for (const address of [lower, `Q${lower.slice(1).toUpperCase()}`, checked]) {
    assert.equal(hasValidQrlAddressCase(address), true);
    assert.equal(toChecksumAddress(address), checked);
  }
  for (let i = 1; i < checked.length; i++) {
    const char = checked.charAt(i);
    if (!/[a-fA-F]/.test(char)) continue;
    const flipped = char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase();
    const bad = checked.slice(0, i) + flipped + checked.slice(i + 1);
    assert.throws(() => toChecksumAddress(bad));
    assert.equal(hasValidQrlAddressCase(bad), false);
  }
});

for (const location of ['scalar', 'array', 'nested struct', 'domain'] as const) {
  test(`main rejects bad checksum casing in a typed-data ${location}`, () => {
    const lower = `Q${'a1'.repeat(64)}`;
    const checked = toChecksumAddress(lower);
    const bad = `QaA${'a1'.repeat(63)}`;
    assert.throws(() => toChecksumAddress(bad));
    for (const address of [lower, `Q${lower.slice(1).toUpperCase()}`, checked, bad]) {
      const payload = payloadWith('address', address);
      if (location === 'array') {
        payload.types['Payload'] = [{ name: 'value', type: 'address[]' }];
        payload.message['value'] = [address];
      } else if (location === 'nested struct') {
        payload.types['Payload'] = [{ name: 'value', type: 'Party' }];
        payload.types['Party'] = [{ name: 'account', type: 'address' }];
        payload.message['value'] = { account: address };
      } else if (location === 'domain') {
        payload.types['Payload'] = [{ name: 'value', type: 'uint8' }];
        payload.message['value'] = 1;
        payload.types['QRLDomain'] = [
          { name: 'name', type: 'string' },
          { name: 'verifyingContract', type: 'address' },
        ];
        payload.domain['verifyingContract'] = address;
      }
      const parsed = SignatureRequestSchema.safeParse({
        kind: 'typedData',
        payload,
        signer: SIGNER,
      });
      assert.equal(parsed.success, address !== bad);
      if (!parsed.success) {
        assert.match(parsed.error.issues[0]?.message ?? '', /invalid QIP-55 checksum casing/);
        assert.throws(() => computeTypedDataDigest(payload), /invalid QIP-55 checksum casing/);
      } else {
        assert.equal(computeTypedDataDigest(payload).length, 64);
      }
    }
  });
}
