/**
 * Build-record store (src/main/buildRecords.ts): what main remembers about a
 * transaction it assembled, so the trusted confirm can name the gas limit's
 * source.
 *
 * Verified here:
 *   - a record round-trips for the EXACT transaction it was made for, and any
 *     change to a signed field is a miss (a record can never be read against a
 *     different transaction)
 *   - records expire on the TTL and the store is bounded, so a long session
 *     cannot grow it and a record cannot outlive its approval
 *   - a rebuild replaces the record and refreshes its position in the FIFO
 *
 * Pure module, no Electron, so it runs under `node --test --import tsx`.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  BUILD_RECORD_TTL_MS,
  buildFingerprint,
  clearBuildRecords,
  recallBuild,
  rememberBuild,
} from '../src/main/buildRecords';
import type { UnsignedTransaction } from '../src/shared/schemas';

const ADDR = 'Q' + 'a'.repeat(128);
const ADDR2 = 'Q' + 'b'.repeat(128);

function tx(overrides: Partial<UnsignedTransaction> = {}): UnsignedTransaction {
  return {
    from: ADDR,
    to: ADDR2,
    value: '1000',
    nonce: 3,
    gas: '350000',
    maxFeePerGas: '2000000000',
    maxPriorityFeePerGas: '1000000000',
    chainId: 3151909,
    type: '0x2',
    ...overrides,
  };
}

beforeEach(() => {
  clearBuildRecords();
});

test('a record round-trips for the transaction it was made for', () => {
  const t = tx();
  rememberBuild(t, { estimatedGas: '120000', requestedGas: '350000' });
  assert.deepEqual(recallBuild(t), { estimatedGas: '120000', requestedGas: '350000' });
});

test('a wallet-only build records no requested limit', () => {
  const t = tx({ gas: '120000' });
  rememberBuild(t, { estimatedGas: '120000' });
  assert.deepEqual(recallBuild(t), { estimatedGas: '120000' });
});

test('an unknown transaction is a miss', () => {
  assert.equal(recallBuild(tx()), undefined);
});

test('changing any signed field is a miss', () => {
  const t = tx({ data: '0xdeadbeef' });
  rememberBuild(t, { estimatedGas: '120000', requestedGas: '350000' });
  const changes: Partial<UnsignedTransaction>[] = [
    { to: ADDR },
    { from: ADDR2 },
    { value: '1001' },
    { nonce: 4 },
    { gas: '350001' },
    { maxFeePerGas: '2000000001' },
    { maxPriorityFeePerGas: '1000000001' },
    { chainId: 1337 },
    { data: '0xdeadbeff' },
  ];
  for (const change of changes) {
    assert.equal(
      recallBuild(tx({ data: '0xdeadbeef', ...change })),
      undefined,
      `changing ${Object.keys(change).join()} must miss`,
    );
  }
  assert.ok(recallBuild(t), 'the original still hits');
});

test('a transaction with calldata does not collide with one without', () => {
  assert.notEqual(buildFingerprint(tx()), buildFingerprint(tx({ data: '0x' })));
});

test('a record expires on the TTL', () => {
  const t = tx();
  const t0 = 1_000_000;
  rememberBuild(t, { estimatedGas: '120000' }, t0);
  assert.ok(recallBuild(t, t0 + BUILD_RECORD_TTL_MS - 1), 'still live just before the TTL');
  assert.equal(recallBuild(t, t0 + BUILD_RECORD_TTL_MS), undefined, 'gone at the TTL');
});

test('the store is bounded, dropping the oldest builds first', () => {
  const many = Array.from({ length: 40 }, (_, i) => tx({ nonce: i }));
  many.forEach((t, i) => {
    rememberBuild(t, { estimatedGas: String(100000 + i) });
  });
  assert.equal(recallBuild(many[0]!), undefined, 'the oldest build was evicted');
  assert.deepEqual(recallBuild(many[39]!), { estimatedGas: '100039' }, 'the newest is held');
});

test('a rebuild of the same transaction replaces its record', () => {
  const t = tx();
  rememberBuild(t, { estimatedGas: '120000', requestedGas: '350000' });
  rememberBuild(t, { estimatedGas: '130000' });
  assert.deepEqual(recallBuild(t), { estimatedGas: '130000' }, 'no stale requestedGas survives');
});
