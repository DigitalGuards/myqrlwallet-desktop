/**
 * Fee math for the RPC transaction builder. marketFees and applyFeeLevel are
 * pure bigint arithmetic (no network), so they run under `node --test --import
 * tsx` directly. marketFees is the web wallet's quoteFees policy (suggested tip
 * times a level multiplier, plus 2x base-fee headroom). applyFeeLevel is the
 * gasPrice fallback: it applies a multiplier to the gas price and keeps the
 * priority tip within that total cap, including when the node quotes less
 * than 1 gwei.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyFeeLevel, marketFees } from '../src/main/rpc';

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

test('marketFees scales the suggested tip per level and adds 2x base-fee headroom', () => {
  const tip = 2n * GWEI;
  const base = 3n * GWEI;
  assert.deepEqual(marketFees(tip, base, 'low'), {
    maxPriorityFeePerGas: 2n * GWEI,
    maxFeePerGas: 8n * GWEI,
  });
  assert.deepEqual(marketFees(tip, base, 'medium'), {
    maxPriorityFeePerGas: 3n * GWEI,
    maxFeePerGas: 9n * GWEI,
  });
  assert.deepEqual(marketFees(tip, base, 'high'), {
    maxPriorityFeePerGas: 4n * GWEI,
    maxFeePerGas: 10n * GWEI,
  });
});

test('marketFees matches the web wallet on the live devnet quote', () => {
  // qrl_maxPriorityFeePerGas 0x9502f900 (2.5 gwei), baseFeePerGas 0x7.
  assert.deepEqual(marketFees(2_500_000_000n, 7n, 'medium'), {
    maxPriorityFeePerGas: 3_750_000_000n,
    maxFeePerGas: 3_750_000_014n,
  });
});

test('marketFees keeps maxFeePerGas >= maxPriorityFeePerGas (EIP-1559 validity)', () => {
  for (const tip of [0n, 1n, GWEI, 100n * GWEI]) {
    for (const base of [0n, 7n, GWEI, 100n * GWEI]) {
      for (const level of ['low', 'medium', 'high'] as const) {
        const { maxFeePerGas, maxPriorityFeePerGas } = marketFees(tip, base, level);
        assert.ok(maxFeePerGas >= maxPriorityFeePerGas, `tip ${tip}, base ${base}, ${level}`);
        assert.ok(maxFeePerGas - maxPriorityFeePerGas >= base, 'covers at least the base fee');
      }
    }
  }
});
