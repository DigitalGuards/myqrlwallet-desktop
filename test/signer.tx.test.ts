/**
 * Transaction-signing smoke test for the signer's spend path.
 *
 * The crypto test covers signMessage; this covers signTransaction, the
 * load-bearing path that produces the raw tx broadcast to the chain. The point
 * we most want to pin down is that signing is FULLY OFFLINE: signTransaction
 * pre-populates `networkId` so web3 never issues a live `net_version` RPC call
 * mid-sign (which would fail with no provider / on a v2 `qrl_*`-only node). If
 * that regressed, this test would hang on a network call or throw, not pass.
 *
 * Runs under `node --test --import tsx` with NO Electron and NO network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deriveSeedFromMnemonic, generateMnemonic, signTransaction } from '../src/signer/signing';
import type { UnsignedTransaction } from '../src/shared/schemas';

const CHAIN_ID = 1337; // testnet v2

function unsignedTx(from: string, to: string): UnsignedTransaction {
  return {
    from,
    to,
    value: '1000000000000000000', // 1 QRL in shor
    nonce: 0,
    gas: '21000',
    maxFeePerGas: '2000000000',
    maxPriorityFeePerGas: '1000000000',
    chainId: CHAIN_ID,
    type: '0x2',
  };
}

test('signTransaction signs a type-2 tx fully offline (no provider, no net_version)', async () => {
  const { hexSeed, address } = deriveSeedFromMnemonic(generateMnemonic());
  const tx = unsignedTx(address, address);

  // No provider is set anywhere; if signing tried a live net_version call this
  // would reject. A clean resolve proves the networkId-offline path holds.
  const result = await signTransaction(hexSeed, tx, CHAIN_ID);

  assert.equal(result.kind, 'transaction');
  assert.equal(result.signer, address, 'signer must be the unlocked account');
  assert.ok(result.rawTransaction, 'must return a raw signed transaction');
  assert.match(result.rawTransaction!, /^0x[0-9a-fA-F]+$/, 'raw tx must be 0x hex');
  // A type-2 ML-DSA-87 signed tx is far larger than any legacy tx; a few KB of
  // signature alone. Guard against an empty/truncated envelope.
  assert.ok(result.rawTransaction!.length > 200, 'raw tx must carry the signature');
  assert.equal(result.signature, result.rawTransaction, 'signature mirrors rawTransaction');
});

test('signTransaction binds to the authoritative chainId argument', async () => {
  const { hexSeed, address } = deriveSeedFromMnemonic(generateMnemonic());
  const tx = unsignedTx(address, address);

  // Two different chain ids must yield different signed envelopes: the chainId
  // is part of the signed payload, so a replay across chains cannot reuse it.
  const a = await signTransaction(hexSeed, tx, 1337);
  const b = await signTransaction(hexSeed, tx, 4242);
  assert.notEqual(a.rawTransaction, b.rawTransaction, 'chainId must bind into the signature');
});

test('signTransaction refuses a tx whose `from` is not the unlocked account', async () => {
  const a = deriveSeedFromMnemonic(generateMnemonic());
  const b = deriveSeedFromMnemonic(generateMnemonic());
  assert.notEqual(a.address, b.address);

  // Sign with a's seed but a tx attributed to b: the guard must reject so a
  // request cannot coax a signature attributed to a different account.
  const tx = unsignedTx(b.address, a.address);
  await assert.rejects(
    () => signTransaction(a.hexSeed, tx, CHAIN_ID),
    /from does not match/,
    'mismatched from must throw',
  );
});
