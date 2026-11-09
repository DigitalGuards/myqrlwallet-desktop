/**
 * Byte-level regression vectors for the signer's transaction path.
 *
 * test/fixtures/signer-tx-vectors.json holds transactions that this module's
 * own signTransaction signed under @theqrl/web3 1.0.3, the lockfile desktop
 * 1.4.8 shipped (`recordedWith` names the packages). ML-DSA-87 signing is
 * hedged: each signature mixes in one 32-byte draw from
 * crypto.getRandomValues. These tests serve the fixture's `rnd` bytes for that
 * draw, so any web3 build that encodes and signs a transaction the same way
 * returns the recorded raw transaction and hash byte for byte.
 *
 * A mismatch means the signed bytes changed. Find out why in the dependency;
 * re-recording the fixture would hide the change this test exists to catch.
 *
 * Runs under `node --test --import tsx` with NO Electron and NO network.
 */
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

import { addressFromHexSeed, signTransaction } from '../src/signer/signing';
import { UnsignedTransactionSchema, parseSignatureResultForRequest } from '../src/shared/schemas';

const HEX_BYTES = /^0x(?:[0-9a-f]{2})+$/;
const HEX_32 = /^0x[0-9a-f]{64}$/;
const RND_BYTES = 32;

const fixtureSchema = z
  .object({
    recordedWith: z.record(z.string(), z.string()),
    hexSeed: z.string().regex(HEX_BYTES),
    signer: z.string(),
    vectors: z
      .array(
        z
          .object({
            label: z.string(),
            rnd: z.string().regex(HEX_32),
            tx: UnsignedTransactionSchema,
            chainId: z.number().int().positive(),
            rawTransaction: z.string().regex(HEX_BYTES),
            transactionHash: z.string().regex(HEX_32),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

const raw: unknown = JSON.parse(
  readFileSync(new URL('./fixtures/signer-tx-vectors.json', import.meta.url), 'utf8'),
);
const fixture = fixtureSchema.parse(raw);

/**
 * Answer every crypto.getRandomValues call made during the test with the
 * bytes of `rnd`, and report the byte length of each request. The platform
 * RNG returns when the test ends.
 */
function fixRandomness(t: TestContext, rnd: Uint8Array): () => number[] {
  const draw = t.mock.method(
    globalThis.crypto,
    'getRandomValues',
    <T extends ArrayBufferView | null>(array: T): T => {
      if (array) {
        const view = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
        for (let i = 0; i < view.length; i++) view[i] = rnd[i % rnd.length] ?? 0;
      }
      return array;
    },
  );
  return () => draw.mock.calls.map((call) => call.arguments[0]?.byteLength ?? -1);
}

test('the vectors were recorded under @theqrl/web3 1.0.3 for the fixture seed', () => {
  assert.equal(fixture.recordedWith['@theqrl/web3'], '1.0.3');
  assert.equal(addressFromHexSeed(fixture.hexSeed), fixture.signer);
  for (const vector of fixture.vectors) {
    assert.equal(vector.tx.from, fixture.signer, vector.label);
  }
});

for (const vector of fixture.vectors) {
  test(`signTransaction reproduces the recorded bytes: ${vector.label}`, async (t) => {
    const draws = fixRandomness(t, Buffer.from(vector.rnd.slice(2), 'hex'));
    const result = await signTransaction(fixture.hexSeed, vector.tx, vector.chainId);

    assert.deepEqual(draws(), [RND_BYTES], 'one 32-byte hedging draw per signature');
    assert.equal(result.rawTransaction, vector.rawTransaction, 'raw signed transaction bytes');
    assert.equal(result.transactionHash, vector.transactionHash, 'transaction hash');
    assert.equal(result.signature, result.rawTransaction);
    assert.equal(result.signer, fixture.signer);
    assert.deepEqual(
      parseSignatureResultForRequest({ ...result }, { kind: 'transaction', tx: vector.tx }),
      result,
      'the recorded output passes the strict process-boundary parser',
    );
  });
}

test('the signer adds the 0x prefix to calldata: both spellings sign the same bytes', () => {
  const prefixed = fixture.vectors.find((vector) => vector.tx.data?.startsWith('0x') === true);
  const bare = fixture.vectors.find(
    (vector) => vector.tx.data !== undefined && !vector.tx.data.startsWith('0x'),
  );
  assert.ok(prefixed && bare, 'the fixture holds both calldata spellings');
  assert.equal(bare.tx.data, prefixed.tx.data?.slice(2));
  assert.equal(bare.rnd, prefixed.rnd);
  assert.equal(bare.rawTransaction, prefixed.rawTransaction);
});

test('signing outside the fixed draw stays hedged: two signatures of one transaction differ', async () => {
  const [vector] = fixture.vectors;
  assert.ok(vector);
  const first = await signTransaction(fixture.hexSeed, vector.tx, vector.chainId);
  const second = await signTransaction(fixture.hexSeed, vector.tx, vector.chainId);
  assert.notEqual(first.rawTransaction, second.rawTransaction);
  assert.equal(first.rawTransaction.length, vector.rawTransaction.length);
  assert.equal(second.rawTransaction.length, vector.rawTransaction.length);
});
