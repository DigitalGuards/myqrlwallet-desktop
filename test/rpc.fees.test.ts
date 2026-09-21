/**
 * Fee-level math for the RPC transaction builder. applyFeeLevel is pure bigint
 * arithmetic (no network), so it runs under `node --test --import tsx` directly.
 * Desktop tiers apply a multiplier to the gas price and keep the priority tip
 * within that total cap, including when the node quotes less than 1 gwei.
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

test('applyFeeLevel applies the preferred tip when the fee cap permits it', () => {
  // base/10 below the floor -> floored to 1 gwei.
  assert.equal(
    applyFeeLevel(1n * GWEI, 'medium').maxPriorityFeePerGas,
    GWEI,
    'sub-floor tip floored',
  );
  // base/10 exactly at the floor (10 gwei base) -> 1 gwei.
  assert.equal(applyFeeLevel(10n * GWEI, 'medium').maxPriorityFeePerGas, GWEI, 'at-floor tip');
  // base/10 above the floor (20 gwei base) -> 2 gwei, not floored.
  assert.equal(
    applyFeeLevel(20n * GWEI, 'medium').maxPriorityFeePerGas,
    2n * GWEI,
    'above-floor tip kept',
  );
});

test('applyFeeLevel preserves a zero-price quote without introducing an invalid tip', () => {
  const { maxFeePerGas, maxPriorityFeePerGas } = applyFeeLevel(0n, 'high');
  assert.equal(maxFeePerGas, 0n);
  assert.equal(maxPriorityFeePerGas, 0n);
});

test('applyFeeLevel keeps maxFeePerGas >= maxPriorityFeePerGas (EIP-1559 validity)', () => {
  for (const base of [0n, 1n, GWEI / 2n, GWEI - 1n, GWEI, 10n * GWEI, 20n * GWEI, 100n * GWEI]) {
    for (const level of ['low', 'medium', 'high'] as const) {
      const { maxFeePerGas, maxPriorityFeePerGas } = applyFeeLevel(base, level);
      assert.ok(maxFeePerGas >= maxPriorityFeePerGas, `level ${level}, base ${base}`);
      assert.ok(maxPriorityFeePerGas >= 0n, 'priority fee must be nonnegative');
    }
  }
});
