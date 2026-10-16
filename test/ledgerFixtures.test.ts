import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { loadFixture } from './ledgerFixtures';

test('Ledger fixture loading validates required fields, optional fields and every exchange', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qrl-ledger-fixture-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'fixture.json');
  const name = path.relative(fileURLToPath(new URL('./fixtures/ledger/', import.meta.url)), file);
  const exchange = { label: 'fixture', apdu: '00', response: '9000' };
  const fixture = { flow: 'identity', model: 'nanosp', exchanges: [exchange] };

  for (const value of [fixture, { ...fixture, path: 'fixture path', expected: { version: 2 } }]) {
    writeFileSync(file, JSON.stringify(value));
    assert.deepEqual(loadFixture(name), value);
  }

  for (const value of [
    null,
    [],
    {},
    { ...fixture, flow: 1 },
    { ...fixture, model: null },
    { ...fixture, path: 1 },
    { ...fixture, expected: null },
    { ...fixture, expected: [] },
    { ...fixture, exchanges: {} },
    { ...fixture, exchanges: [null] },
    { ...fixture, exchanges: [exchange, { ...exchange, label: null }] },
    { ...fixture, exchanges: [{ ...exchange, apdu: 0 }] },
    { ...fixture, exchanges: [{ ...exchange, response: [] }] },
  ]) {
    writeFileSync(file, JSON.stringify(value));
    assert.throws(() => loadFixture(name), /invalid Ledger fixture/);
  }
});
