import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { hasLegacyWalletData } from '../src/main/legacyData';

async function scratch(): Promise<string> {
  return fs.mkdtemp(path.join(tmpdir(), 'qrl-legacy-'));
}

test('a clean install reports no legacy wallet data', async () => {
  const dir = await scratch();
  assert.equal(await hasLegacyWalletData(dir), false);
});

test('a missing userData directory reports no legacy wallet data', async () => {
  const dir = await scratch();
  assert.equal(await hasLegacyWalletData(path.join(dir, 'never-created')), false);
});

test('a leftover wallet directory with no envelope reports nothing to recover', async () => {
  const dir = await scratch();
  // What a v1.0.x user who removed every wallet leaves behind.
  await fs.mkdir(path.join(dir, 'wallet', 'seeds'), { recursive: true });
  await fs.writeFile(path.join(dir, 'wallet', 'active.json'), '{}');
  assert.equal(await hasLegacyWalletData(dir), false);
});

test('temp and quarantined files alone do not count as recoverable data', async () => {
  const dir = await scratch();
  const seeds = path.join(dir, 'wallet', 'seeds');
  await fs.mkdir(seeds, { recursive: true });
  await fs.writeFile(path.join(seeds, 'qdead.json.4242.0.tmp'), '{}');
  await fs.writeFile(path.join(seeds, 'qdead.json.corrupt-1700000000000'), '{}');
  assert.equal(await hasLegacyWalletData(dir), false);
});

test('a per-address envelope is detected', async () => {
  const dir = await scratch();
  const seeds = path.join(dir, 'wallet', 'seeds');
  await fs.mkdir(seeds, { recursive: true });
  await fs.writeFile(path.join(seeds, `q${'a'.repeat(40)}.json`), '{}');
  assert.equal(await hasLegacyWalletData(dir), true);
});

test('the pre-multi-wallet single envelope is detected', async () => {
  const dir = await scratch();
  await fs.mkdir(path.join(dir, 'wallet'), { recursive: true });
  await fs.writeFile(path.join(dir, 'wallet', 'seed.json'), '{}');
  assert.equal(await hasLegacyWalletData(dir), true);
});
