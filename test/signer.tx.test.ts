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

import {
  deriveSeedFromHexSeed,
  deriveSeedFromMnemonic,
  generateMnemonic,
  signTransaction,
} from '../src/signer/signing';
import { parseSignatureResultForRequest } from '../src/shared/schemas';
import type { UnsignedTransaction } from '../src/shared/schemas';

const CHAIN_ID = 3151909; // private v3 testnet

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
  assert.deepEqual(
    parseSignatureResultForRequest({ ...result }, { kind: 'transaction', tx }),
    result,
    'the real signer output must pass the strict process-boundary parser',
  );

  assert.equal(result.kind, 'transaction');
  assert.equal(result.signer, address, 'signer must be the unlocked account');
  assert.ok(result.rawTransaction, 'must return a raw signed transaction');
  assert.match(result.rawTransaction, /^0x[0-9a-fA-F]+$/, 'raw tx must be 0x hex');
  // A type-2 ML-DSA-87 signed tx is far larger than any legacy tx; a few KB of
  // signature alone. Guard against an empty/truncated envelope.
  assert.ok(result.rawTransaction.length > 200, 'raw tx must carry the signature');
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

test('signTransaction carries calldata into the signed envelope', async () => {
  const { hexSeed, address } = deriveSeedFromMnemonic(generateMnemonic());
  // A contract-call tx needs gas above the 21000 native floor to cover the
  // calldata's intrinsic gas (this is what buildTransaction's 90000 default is
  // for); use the same gas on both so the only difference is the data field.
  const gas = '90000';
  const bare = await signTransaction(hexSeed, { ...unsignedTx(address, address), gas }, CHAIN_ID);
  const withData = await signTransaction(
    hexSeed,
    { ...unsignedTx(address, address), gas, data: '0xabcd1234' },
    CHAIN_ID,
  );
  assert.match(withData.rawTransaction, /^0x[0-9a-fA-F]+$/);
  // The calldata must be encoded into the signed tx, so it is strictly longer
  // than the same transfer with no data.
  assert.ok(
    withData.rawTransaction.length > bare.rawTransaction.length,
    'calldata must grow the raw tx',
  );
});

test('signTransaction signs a zero-value transfer', async () => {
  const { hexSeed, address } = deriveSeedFromMnemonic(generateMnemonic());
  const result = await signTransaction(
    hexSeed,
    { ...unsignedTx(address, address), value: '0' },
    CHAIN_ID,
  );
  assert.equal(result.kind, 'transaction');
  assert.match(result.rawTransaction, /^0x[0-9a-fA-F]+$/);
});

test('every seed the signer derives carries the 0x prefix @theqrl/web3 2.0.0 requires', async () => {
  const mnemonic = generateMnemonic();
  const fromMnemonic = deriveSeedFromMnemonic(mnemonic);
  const body = fromMnemonic.hexSeed.slice(2);
  assert.match(fromMnemonic.hexSeed, /^0x[0-9a-f]{102}$/);

  // Import sources the envelope can come from: a recovery phrase, a 0x hex
  // seed, and the bare or upper-case hex a user pastes. Each stores the one
  // spelling wallet.js returns, and that spelling signs.
  for (const input of [`0x${body}`, body, body.toUpperCase()]) {
    const derived = deriveSeedFromHexSeed(input);
    assert.equal(derived.hexSeed, fromMnemonic.hexSeed, input.slice(0, 4));
    assert.equal(derived.address, fromMnemonic.address);
  }
  const tx = unsignedTx(fromMnemonic.address, fromMnemonic.address);
  const signed = await signTransaction(fromMnemonic.hexSeed, tx, CHAIN_ID);
  assert.match(signed.rawTransaction, /^0x[0-9a-f]+$/);

  // web3 2.0.0 refuses a string seed without the lowercase 0x prefix
  // (1.0.3 signed with it), which is why the stored spelling matters.
  await assert.rejects(() => signTransaction(body, tx, CHAIN_ID));
});

test('signTransaction makes no network request (web3 2.0.0 checks the node chain id only with a provider)', async (t) => {
  const fetchCalls = t.mock.method(globalThis, 'fetch', () =>
    Promise.reject(new Error('the signer must stay offline')),
  );
  const { hexSeed, address } = deriveSeedFromMnemonic(generateMnemonic());
  // A chain id no node serves: with a provider, 2.0.0 would ask the node and
  // refuse the mismatch. The signer has none, so it signs for the chain id
  // main passed, as before.
  const result = await signTransaction(hexSeed, unsignedTx(address, address), 4242);
  assert.match(result.rawTransaction, /^0x[0-9a-f]+$/);
  assert.equal(fetchCalls.mock.callCount(), 0);
});

test('signTransaction refuses fee and amount fields a type-2 transaction cannot carry', async () => {
  const { hexSeed, address } = deriveSeedFromMnemonic(generateMnemonic());
  const base = unsignedTx(address, address);
  const overUint256 = (1n << 256n).toString();
  // The IPC schema admits 80-digit amounts; the encoder caps them at 2^256-1.
  // Both web3 1.0.3 and 2.0.0 refuse these before signing; only the error
  // class and text differ between them.
  const refused: UnsignedTransaction[] = [
    { ...base, maxPriorityFeePerGas: '3000000000' }, // priority fee above the fee cap
    { ...base, value: overUint256 },
    { ...base, maxFeePerGas: overUint256, maxPriorityFeePerGas: '1' },
    // gas x maxFeePerGas above 2^256-1
    { ...base, maxFeePerGas: ((1n << 256n) - 1n).toString(), maxPriorityFeePerGas: '1' },
  ];
  for (const tx of refused) {
    await assert.rejects(() => signTransaction(hexSeed, tx, CHAIN_ID));
  }
});
