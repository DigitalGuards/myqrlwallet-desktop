import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { buildSync } from 'esbuild';
import { STORAGE_MIGRATION_URL } from '../src/shared/appUrls';
import {
  LEGACY_STORAGE_MIGRATION_URL,
  STORAGE_MIGRATION_CHANNEL,
  isStorageEntries,
  type StorageEntries,
} from '../src/shared/storageMigration';

const compiled = buildSync({
  entryPoints: ['src/preload/storageMigration.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  write: false,
}).outputFiles[0]?.text;
assert.ok(compiled);
const preload = compiled;
const entries: StorageEntries = [
  ['qrlwallet:preference', 'raw value'],
  ['qrl:transaction-history:v1:qrl:from:hash', 'transaction history'],
  ['qrl_TOKEN_LIST_V3', 'custom tokens'],
  ['@qrlwallet/connect:session', 'connect session'],
  ['arbitrary', ' whitespace\n\u0000\ud800中文 '],
  ['empty value', ''],
  ['', 'empty key value'],
];

function storage(values: Map<string, string>) {
  return {
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

async function runPreload(
  href: string,
  localStorage: Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem'>,
  snapshot: unknown = entries,
): Promise<unknown[]> {
  let loaded: (() => void) | undefined;
  let finish: (() => void) | undefined;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const messages: unknown[] = [];
  runInNewContext(preload, {
    location: { href },
    localStorage,
    window: {
      addEventListener: (event: string, listener: () => void) => {
        assert.equal(event, 'DOMContentLoaded');
        loaded = listener;
      },
    },
    require: (name: string) => {
      assert.equal(name, 'electron');
      return {
        ipcRenderer: {
          invoke: (channel: string, message: unknown) => {
            assert.equal(channel, STORAGE_MIGRATION_CHANNEL);
            assert.ok(message && typeof message === 'object' && 'step' in message);
            messages.push(message);
            if (message.step === 'write') return Promise.resolve(snapshot);
            finish?.();
            return Promise.resolve();
          },
        },
      };
    },
  });
  assert.ok(loaded);
  loaded();
  await done;
  return structuredClone(messages);
}

test('storage entries accept every string key and value and reject malformed pairs', () => {
  assert.equal(isStorageEntries(entries), true);
  assert.equal(isStorageEntries([['', '']]), true);
  for (const malformed of [null, {}, [['key']], [['key', 1]], [[1, 'value']], [['a', 'b', 'c']]]) {
    assert.equal(isStorageEntries(malformed), false);
  }
});

test('legacy reader sends every entry unchanged from the constant file URL', async () => {
  const source = new Map(entries);
  assert.deepEqual(await runPreload(LEGACY_STORAGE_MIGRATION_URL, storage(source)), [
    { step: 'read', entries },
  ]);
  assert.deepEqual([...source], entries);
});

test('writer fills absent keys and preserves existing destination values including empty strings', async () => {
  const destination = new Map([
    ['arbitrary', 'newer value'],
    ['qrl_TOKEN_LIST_V3', ''],
    ['', 'newer empty key value'],
  ]);
  assert.deepEqual(await runPreload(STORAGE_MIGRATION_URL, storage(destination)), [
    { step: 'write' },
    { step: 'complete' },
  ]);
  for (const [key, value] of entries) {
    const expected =
      key === 'arbitrary'
        ? 'newer value'
        : key === 'qrl_TOKEN_LIST_V3'
          ? ''
          : key === ''
            ? 'newer empty key value'
            : value;
    assert.equal(destination.get(key), expected);
  }
});

test('partial write failure reports only a fixed status and retry preserves subsequent edits', async () => {
  const destination = new Map<string, string>();
  const failing = storage(destination);
  failing.setItem = (key, value) => {
    if (destination.size === 1) throw new Error(`${key}: ${value}`);
    destination.set(key, value);
  };
  assert.deepEqual(await runPreload(STORAGE_MIGRATION_URL, failing), [
    { step: 'write' },
    { step: 'failed' },
  ]);
  assert.equal(destination.size, 1);
  destination.set('qrlwallet:preference', 'edited after failure');
  assert.deepEqual(await runPreload(STORAGE_MIGRATION_URL, storage(destination)), [
    { step: 'write' },
    { step: 'complete' },
  ]);
  assert.equal(destination.get('qrlwallet:preference'), 'edited after failure');
  for (const [key, value] of entries.slice(1)) assert.equal(destination.get(key), value);
});

test('verification fails if a newly written value differs or any legacy key disappears', async () => {
  const corrupted = storage(new Map<string, string>());
  corrupted.setItem = () => {
    // Simulate a storage write that silently drops the entry.
  };
  assert.deepEqual(await runPreload(STORAGE_MIGRATION_URL, corrupted), [
    { step: 'write' },
    { step: 'failed' },
  ]);
  // Simulate a store that accepts writes but returns changed strings.
  const changed = new Map<string, string>();
  const wrongValue = storage(changed);
  wrongValue.setItem = (key) => {
    changed.set(key, 'wrong value');
  };
  assert.deepEqual(await runPreload(STORAGE_MIGRATION_URL, wrongValue), [
    { step: 'write' },
    { step: 'failed' },
  ]);
  const vanished = storage(new Map([['existing', 'destination value']]));
  let reads = 0;
  vanished.getItem = () => (++reads === 1 ? 'destination value' : null);
  assert.deepEqual(await runPreload(STORAGE_MIGRATION_URL, vanished, [['existing', 'legacy']]), [
    { step: 'write' },
    { step: 'failed' },
  ]);
});
