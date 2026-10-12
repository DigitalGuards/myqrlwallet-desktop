import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { register } from 'node:module';
import path from 'node:path';
import { after, test, type TestContext } from 'node:test';
import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron';
import { summariseSignatureRequest } from '../src/main/confirmSummary';
import { signWithConfirmation } from '../src/main/signatureRequest';
import { parseSignerRequest } from '../src/shared/protocolGuards';
import type { SignerRequest } from '../src/shared/protocol';
import { payloadWith, SIGNER } from './typedDataFixtures';
import { RECIPIENTS, reviewRequest, withReviewDomain } from './typedDataReviewFixtures';

register(new URL('./electronMockLoader.mjs', import.meta.url));
const { app, BrowserWindow, dialog, utilityProcess } = await import('electron');
const { confirmSignature, confirmRemoveWallet } = await import('../src/main/confirm');
const { SignerBridge } = await import('../src/main/signerBridge');

// The packaged main bundle supplies this CommonJS global.
Object.defineProperty(globalThis, '__dirname', { value: '.', configurable: true });
mkdirSync('out', { recursive: true });
const userData = mkdtempSync(path.join('out', 'confirm-test-'));
after(() => {
  rmSync(userData, { recursive: true, force: true });
  Reflect.deleteProperty(globalThis, '__dirname');
});

const parent = new BrowserWindow();
const request = reviewRequest(withReviewDomain(payloadWith('address[]', RECIPIENTS)));
const pageCount = summariseSignatureRequest(request, { connectedChainId: 3151909 }).pages.length;
const lockError = 'Wallet locked during confirmation. Please unlock and try again.';

class MockSigner extends EventEmitter {
  readonly requests: SignerRequest[] = [];
  readonly pid = 1;
  readonly stdout = null;
  readonly stderr = null;
  unlocked = true;

  postMessage(data: unknown): void {
    const req = parseSignerRequest(data);
    assert.ok(req);
    this.requests.push(req);
    if (req.type === 'signer:create') return;
    if (req.type === 'signer:lock') this.unlocked = false;
    const result =
      req.type === 'signer:status'
        ? { unlocked: this.unlocked, address: this.unlocked ? SIGNER : null, unlockExpiresAt: null }
        : null;
    queueMicrotask(() => this.emit('message', { ok: true, id: req.id, result }));
  }

  kill(): boolean {
    this.emit('exit', 0);
    return true;
  }
}

async function mockSigner(t: TestContext) {
  const children: MockSigner[] = [];
  t.mock.method(app, 'getPath', () => userData);
  t.mock.method(console, 'log', () => undefined);
  t.mock.method(utilityProcess, 'fork', () => {
    const child = new MockSigner();
    children.push(child);
    queueMicrotask(() => child.emit('message', { type: 'signer:ready' }));
    return child;
  });
  const dropped = t.mock.fn();
  const bridge = new SignerBridge(dropped);
  await bridge.start();
  const child = children[0];
  assert.ok(child);
  t.after(() => bridge.shutdown());
  return { bridge, child, children, dropped };
}

function waitForAbort(signal: AbortSignal, response = 1): Promise<MessageBoxReturnValue> {
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve({ response, checkboxChecked: false }), {
      once: true,
    });
  });
}

for (const cause of ['manual lock', 'autolock', 'signer exit'] as const) {
  for (const page of [1, pageCount]) {
    test(
      `${cause} aborts page ${page} and rejects the signing request`,
      { timeout: 3000 },
      async (t) => {
        assert.ok(pageCount > 1);
        const { bridge, child, children, dropped } = await mockSigner(t);
        const signals: AbortSignal[] = [];
        const opened = new Promise<AbortSignal>((resolve) => {
          t.mock.method(
            dialog,
            'showMessageBox',
            (_owner: unknown, options?: MessageBoxOptions) => {
              const signal = options?.signal;
              assert.ok(signal);
              signals.push(signal);
              if (signals.length < page)
                return Promise.resolve({ response: 0, checkboxChecked: false });
              resolve(signal);
              return waitForAbort(signal);
            },
          );
        });
        const rejected = assert.rejects(
          signWithConfirmation(request, {
            signer: bridge,
            confirm: (req, context) => confirmSignature(parent, req, context),
          }),
          { message: lockError },
        );
        const signal = await opened;
        if (cause === 'manual lock') await bridge.lock();
        else if (cause === 'autolock') child.emit('message', { type: 'signer:autolock' });
        else child.emit('exit', 9);
        await rejected;
        assert.equal(signal.aborted, true);
        assert.equal(signals.length, page, 'no later page opens');
        assert.equal(new Set(signals).size, 1, 'one signal covers the whole request');
        assert.equal(
          children.flatMap((process) => process.requests).some((req) => req.type === 'signer:sign'),
          false,
        );
        assert.equal(dropped.mock.callCount(), cause === 'manual lock' ? 0 : 1);
        assert.equal(children.length, cause === 'signer exit' ? 2 : 1);
      },
    );
  }
}

test('locking aborts all pending confirmations, including removal and a racing approval', async (t) => {
  const { bridge } = await mockSigner(t);
  const signals: AbortSignal[] = [];
  t.mock.method(dialog, 'showMessageBox', (_owner: unknown, options?: MessageBoxOptions) => {
    const signal = options?.signal;
    assert.ok(signal);
    signals.push(signal);
    return waitForAbort(signal, 0);
  });
  const rejected = [
    assert.rejects(confirmSignature(parent, request), { message: lockError }),
    assert.rejects(confirmRemoveWallet(parent, SIGNER), { message: lockError }),
  ];
  assert.equal(signals.length, 2);
  await bridge.lock();
  await Promise.all(rejected);
  assert.ok(signals.every((signal) => signal.aborted));
  assert.equal(signals.length, 2);
});

test('completed dialogs release their signals and a fresh confirmation can proceed', async (t) => {
  const { bridge } = await mockSigner(t);
  const signals: AbortSignal[] = [];
  t.mock.method(dialog, 'showMessageBox', async (_owner: unknown, options?: MessageBoxOptions) => {
    assert.ok(options?.signal);
    signals.push(options.signal);
    return { response: 0, checkboxChecked: false };
  });
  assert.equal(await confirmSignature(parent, request), true);
  await bridge.lock();
  assert.ok(signals.every((signal) => !signal.aborted));
  assert.equal(await confirmSignature(parent, request), true);
  assert.equal(new Set(signals).size, 2);
});

test('signer exits and restarts reach main.log with lifecycle metadata only', async (t) => {
  const { bridge, child, children } = await mockSigner(t);
  const rejected = assert.rejects(
    bridge.create('private-test-password'),
    /signer exited \(code 137\)/,
  );
  child.emit('exit', 137);
  await rejected;
  assert.equal(children.length, 2);
  const log = readFileSync(path.join(userData, 'logs', 'main.log'), 'utf8');
  assert.match(log, /\[signer\] exited \(code 137, signal unavailable\)/);
  assert.match(log, /\[signer\] restarting \(attempt 1\/3\)/);
  for (const line of log.trim().split('\n')) {
    assert.match(
      line,
      /^\S+ \[signer\] (exited \(code \d+, signal unavailable\)|restarting \(attempt \d\/3\))$/,
    );
  }
  assert.equal(log.includes('private-test-password'), false);
});
