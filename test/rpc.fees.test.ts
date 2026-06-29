/**
 * Fee-level math for the RPC transaction builder. applyFeeLevel is pure bigint
 * arithmetic (no network), so it runs under `node --test --import tsx` directly.
 * Mirrors the web wallet's fee policy: a per-level multiplier on the base gas
 * price, and a priority tip of base/10 floored at 1 gwei.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyFeeLevel } from '../src/main/rpc';

const GWEI = 1_000_000_000n;

test('applyFeeLevel scales maxFeePerGas by the per-level multiplier', () => {
  const base = 10n * GWEI;
  assert.equal(applyFeeLevel(base, 'low').maxFeePerGas, base, 'low = 1.00x');
  assert.equal(applyFeeLevel(base, 'medium').maxFeePerGas, (base * 120n) / 100n, 'medium = 1.20x');
  assert.equal(applyFeeLevel(base, 'high').maxFeePerGas, (base * 150n) / 100n, 'high = 1.50x');
});

test('applyFeeLevel floors the priority tip at 1 gwei but leaves larger tips alone', () => {
  // base/10 below the floor -> floored to 1 gwei.
  assert.equal(applyFeeLevel(1n * GWEI, 'medium').maxPriorityFeePerGas, GWEI, 'sub-floor tip floored');
  // base/10 exactly at the floor (10 gwei base) -> 1 gwei.
  assert.equal(applyFeeLevel(10n * GWEI, 'medium').maxPriorityFeePerGas, GWEI, 'at-floor tip');
  // base/10 above the floor (20 gwei base) -> 2 gwei, not floored.
  assert.equal(applyFeeLevel(20n * GWEI, 'medium').maxPriorityFeePerGas, 2n * GWEI, 'above-floor tip kept');
});

test('applyFeeLevel handles a zero base (maxFee 0, tip floored)', () => {
  const { maxFeePerGas, maxPriorityFeePerGas } = applyFeeLevel(0n, 'high');
  assert.equal(maxFeePerGas, 0n);
  assert.equal(maxPriorityFeePerGas, GWEI, 'tip floored even at base 0');
});

test('applyFeeLevel keeps maxFeePerGas >= maxPriorityFeePerGas (EIP-1559 validity)', () => {
  for (const base of [10n * GWEI, 20n * GWEI, 100n * GWEI]) {
    for (const level of ['low', 'medium', 'high'] as const) {
      const { maxFeePerGas, maxPriorityFeePerGas } = applyFeeLevel(base, level);
      assert.ok(maxFeePerGas >= maxPriorityFeePerGas, `level ${level}, base ${base}`);
    }
  }
});
