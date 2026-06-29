/**
 * calibrate-kdf.ts
 *
 * Benchmarks Argon2id KEK derivation across several memoryCost values on THIS
 * hardware and recommends the smallest memoryCost whose median derivation time
 * lands at or above 500 ms (the Sparrow-style hardening target documented in
 * docs/ARCHITECTURE_RESEARCH.md).
 *
 * Pure Node (no Electron). Run with: npm run calibrate:kdf
 *
 * IMPORTANT: the chosen params are FROZEN into KDF_DEFAULTS in
 * src/shared/constants.ts and are persisted with every encrypted seed.
 * Changing them later breaks decryption of all existing wallets, so pick once
 * on representative target hardware and do not drift.
 */

// Import the enums as TYPES only (verbatimModuleSyntax forbids using ambient
// const enums as values); the numeric values match KDF_DEFAULTS in constants.ts.
import { hashRaw, type Algorithm, type Version } from '@node-rs/argon2';
import { performance } from 'node:perf_hooks';

/** memoryCost candidates in KiB: 128 MiB, 256 MiB, 384 MiB. */
const MEMORY_COSTS_KIB = [131072, 262144, 393216] as const;

/** Fixed, non-secret params held constant across the sweep. */
const TIME_COST = 3;
const PARALLELISM = 1;
const OUTPUT_LEN = 32;
const SALT_BYTES = 16;

/** Median target in milliseconds. */
const TARGET_MS = 500;

/** Samples per candidate (median is robust to a stray GC pause). */
const SAMPLES = 5;

/** Fixed 16-byte salt: benchmark only, not used to encrypt anything. */
const SALT = Buffer.alloc(SALT_BYTES, 0x42);
const PASSWORD = Buffer.from('correct horse battery staple', 'utf8');

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length === 0) {
    return Number.NaN;
  }
  if (sorted.length % 2 === 1) {
    // noUncheckedIndexedAccess: guard the access.
    return sorted[mid] ?? Number.NaN;
  }
  const lo = sorted[mid - 1] ?? Number.NaN;
  const hi = sorted[mid] ?? Number.NaN;
  return (lo + hi) / 2;
}

async function deriveOnce(memoryCost: number): Promise<number> {
  const start = performance.now();
  await hashRaw(PASSWORD, {
    algorithm: 2 as Algorithm, // Argon2id
    version: 1 as Version, // V0x13
    memoryCost,
    timeCost: TIME_COST,
    parallelism: PARALLELISM,
    outputLen: OUTPUT_LEN,
    salt: SALT,
  });
  return performance.now() - start;
}

interface Row {
  memoryCostKiB: number;
  memoryMiB: number;
  medianMs: number;
  minMs: number;
  maxMs: number;
}

async function main(): Promise<void> {
  console.log(
    'Argon2id KEK calibration (timeCost=%d, parallelism=%d, outputLen=%d)',
    TIME_COST,
    PARALLELISM,
    OUTPUT_LEN,
  );
  console.log('Target: median >= %d ms. Samples per candidate: %d.\n', TARGET_MS, SAMPLES);

  const rows: Row[] = [];

  for (const memoryCost of MEMORY_COSTS_KIB) {
    // One untimed warm-up to amortize allocator/JIT effects.
    await deriveOnce(memoryCost);

    const samples: number[] = [];
    for (let i = 0; i < SAMPLES; i += 1) {
      samples.push(await deriveOnce(memoryCost));
    }

    rows.push({
      memoryCostKiB: memoryCost,
      memoryMiB: Math.round(memoryCost / 1024),
      medianMs: median(samples),
      minMs: Math.min(...samples),
      maxMs: Math.max(...samples),
    });
  }

  // --- Table ---------------------------------------------------------------
  const header = ['memoryCost (KiB)', 'mem (MiB)', 'median (ms)', 'min (ms)', 'max (ms)'];
  console.log(header.join('  |  '));
  console.log('-'.repeat(header.join('  |  ').length));
  for (const r of rows) {
    console.log(
      [
        String(r.memoryCostKiB).padStart(16),
        String(r.memoryMiB).padStart(9),
        r.medianMs.toFixed(1).padStart(11),
        r.minMs.toFixed(1).padStart(8),
        r.maxMs.toFixed(1).padStart(8),
      ].join('  |  '),
    );
  }
  console.log('');

  // --- Recommendation: smallest memoryCost whose median >= TARGET_MS -------
  const recommended = rows.find((r) => r.medianMs >= TARGET_MS);

  if (recommended) {
    console.log(
      'Recommended memoryCost: %d KiB (%d MiB), median %s ms.',
      recommended.memoryCostKiB,
      recommended.memoryMiB,
      recommended.medianMs.toFixed(1),
    );
  } else {
    const slowest = rows[rows.length - 1];
    console.log(
      'No candidate reached the %d ms target on this hardware. Slowest tested: %s KiB at %s ms median.',
      TARGET_MS,
      slowest ? String(slowest.memoryCostKiB) : 'n/a',
      slowest ? slowest.medianMs.toFixed(1) : 'n/a',
    );
    console.log('Consider raising timeCost or adding higher memoryCost candidates.');
  }

  console.log('');
  console.log('REMINDER: freeze the chosen params into KDF_DEFAULTS in');
  console.log('src/shared/constants.ts. They are persisted with every encrypted');
  console.log('seed; changing them later breaks decryption of existing wallets.');
}

main().catch((err: unknown) => {
  console.error('[calibrate-kdf] failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
