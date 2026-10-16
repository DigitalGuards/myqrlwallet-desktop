import assert from 'node:assert/strict';
import { Console } from 'node:console';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { register } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { test } from 'node:test';

register(new URL('./electronMockLoader.mjs', import.meta.url));
const { app } = await import('electron');
const { logConsole, logMain } = await import('../src/main/log');

function captureConsole() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stream = (chunks: string[]) =>
    new Writable({
      write(chunk: Uint8Array, _encoding, callback) {
        chunks.push(Buffer.from(chunk).toString('utf8'));
        callback();
      },
    });
  return {
    console: new Console({ stdout: stream(stdout), stderr: stream(stderr) }),
    stdout,
    stderr,
  };
}

test('console forwarding preserves levels, argument identity and output without file logging', (t) => {
  const userData = mkdtempSync(path.join(tmpdir(), 'qrl-log-console-'));
  t.after(() => rmSync(userData, { recursive: true, force: true }));
  const getPath = t.mock.method(app, 'getPath', () => userData);
  const actual = captureConsole();
  const expected = captureConsole();
  const error = new Error('diagnostic fixture');
  error.stack = 'Error: diagnostic fixture';
  const calls: unknown[][] = [
    [],
    ['plain message'],
    ['values %s %d', 'text', 3, undefined, null, { ok: true }],
    ['operation failed', error],
  ];

  for (const level of ['log', 'warn', 'error'] as const) {
    const forwarded = t.mock.method(console, level, (...args: unknown[]) =>
      actual.console[level](...args),
    );
    for (const args of calls) {
      expected.console[level](...args);
      logConsole[level](...args);
    }
    assert.equal(forwarded.mock.callCount(), calls.length);
    for (const [index, args] of calls.entries()) {
      const received = forwarded.mock.calls[index]?.arguments;
      assert.ok(received);
      assert.equal(received.length, args.length);
      for (const [argument, value] of args.entries()) {
        assert.equal(received[argument], value);
      }
    }
  }

  assert.deepEqual(actual.stdout, expected.stdout);
  assert.deepEqual(actual.stderr, expected.stderr);
  assert.equal(getPath.mock.callCount(), 0);
  assert.deepEqual(readdirSync(userData), []);
});

test('file logging retains its timestamped console mirror and main.log destination', (t) => {
  const userData = mkdtempSync(path.join(tmpdir(), 'qrl-log-file-'));
  t.after(() => rmSync(userData, { recursive: true, force: true }));
  t.mock.method(app, 'getPath', () => userData);
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 0, 1) });
  const output = t.mock.method(console, 'log', () => undefined);

  logMain('diagnostic fixture');

  const line = '2026-01-01T00:00:00.000Z diagnostic fixture';
  assert.equal(output.mock.callCount(), 1);
  assert.deepEqual(output.mock.calls[0]?.arguments, [line]);
  assert.equal(readFileSync(path.join(userData, 'logs', 'main.log'), 'utf8'), `${line}\n`);
});
