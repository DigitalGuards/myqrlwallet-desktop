import assert from 'node:assert/strict';
import { register } from 'node:module';
import { beforeEach, test, type TestContext } from 'node:test';
import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron';
import type { SignatureRequest } from '../src/shared/schemas';
import { signWithConfirmation } from '../src/main/signatureRequest';
import { summariseSignatureRequest } from '../src/main/confirmSummary';
import { payloadWith, SIGNER } from './typedDataFixtures';
import { RECIPIENTS, reviewRequest, withReviewDomain } from './typedDataReviewFixtures';
import {
  advanceConfirmations,
  finishConfirmation,
  flushConfirmations,
  mockConfirmationClock,
} from './confirmationClock';

register(new URL('./electronMockLoader.mjs', import.meta.url));
const { BrowserWindow, dialog } = await import('electron');
const { confirmSignature, confirmRemoveWallet } = await import('../src/main/confirm');
const { ARM_DELAY_MS, confirmationGate } = await import('../src/main/confirmationGate');
beforeEach(mockConfirmationClock);

const message: SignatureRequest = { kind: 'message', signer: SIGNER, messageHex: '0x01' };
const typed = reviewRequest(withReviewDomain(payloadWith('address[]', RECIPIENTS)));
const context = { connectedChainId: 3151909 };
const pageCount = summariseSignatureRequest(typed, context).pages.length;
const busyError = /another confirmation is already open/;

function manualDialogs(t: TestContext, approveOnAbort = false) {
  const parent = new BrowserWindow();
  const shown: { options: MessageBoxOptions; at: number }[] = [];
  let answer: ((response: number) => void) | undefined;
  t.mock.method(dialog, 'showMessageBox', (_owner: unknown, options?: MessageBoxOptions) => {
    assert.ok(options?.signal);
    const { signal } = options;
    assert.equal(answer, undefined, 'only one native dialog is visible');
    shown.push({ options, at: Date.now() });
    return new Promise<MessageBoxReturnValue>((resolve) => {
      const abort = () => {
        const response = approveOnAbort
          ? options.buttons?.indexOf('Approve & sign')
          : options.cancelId;
        answer?.(response ?? 0);
      };
      answer = (response) => {
        answer = undefined;
        signal.removeEventListener('abort', abort);
        resolve({ response, checkboxChecked: false });
      };
      signal.addEventListener('abort', abort, { once: true });
    });
  });
  const click = (response: number): boolean => {
    if (!answer) return false;
    answer(response);
    return true;
  };
  return { parent, shown, click };
}

for (const idle of [0, ARM_DELAY_MS * 3]) {
  test(`request arrival arms the first dialog after ${idle} ms idle`, async (t) => {
    const { parent, shown, click } = manualDialogs(t);
    await advanceConfirmations(t, idle);
    const arrivedAt = Date.now();
    const approved = confirmationGate.show(parent, [{ message: 'Confirm signature' }], 1);
    await flushConfirmations();
    assert.equal(shown.length, 0);
    assert.equal(click(1), false);
    await advanceConfirmations(t, ARM_DELAY_MS - 1);
    assert.equal(shown.length, 0);
    assert.equal(click(1), false);
    await assert.rejects(confirmSignature(parent, message), busyError);
    await advanceConfirmations(t, 1);
    assert.equal(shown.length, 1);
    assert.equal(shown[0]?.at, arrivedAt + ARM_DELAY_MS);
    click(1);
    assert.equal(await approved, true);
  });
}

test('a throwing webContents getter releases the busy slot for a healthy parent', async (t) => {
  const { parent, shown, click } = manualDialogs(t);
  const failedParent = new BrowserWindow();
  Object.defineProperty(failedParent, 'webContents', {
    get() {
      throw new Error('webContents unavailable');
    },
  });
  const pages = [{ message: 'Confirm signature' }];
  await assert.rejects(confirmationGate.show(failedParent, pages, 1), /webContents unavailable/);
  const approved = confirmationGate.show(parent, pages, 1);
  await flushConfirmations();
  assert.equal(shown.length, 0);
  await advanceConfirmations(t, ARM_DELAY_MS);
  assert.equal(shown.length, 1);
  click(1);
  assert.equal(await approved, true);
});

test('a listener registration failure removes earlier listeners and releases the busy slot', async (t) => {
  const { parent, shown, click } = manualDialogs(t);
  const failedParent = new BrowserWindow();
  t.mock.method(failedParent, 'on', () => {
    throw new Error('listener registration failed');
  });
  await assert.rejects(confirmSignature(failedParent, message), /listener registration failed/);
  for (const event of ['did-start-navigation', 'did-navigate', 'render-process-gone']) {
    assert.equal(failedParent.webContents.listenerCount(event), 0);
  }
  assert.equal(failedParent.listenerCount('closed'), 0);
  const approved = confirmSignature(parent, message);
  await advanceConfirmations(t, ARM_DELAY_MS);
  assert.equal(shown.length, 1);
  click(1);
  assert.equal(await approved, true);
});

for (const owner of ['signature', 'removal'] as const) {
  test(`${owner} holds the busy slot while open and during the next request's arming delay`, async (t) => {
    const { parent, shown, click } = manualDialogs(t);
    const start = () =>
      owner === 'signature'
        ? confirmSignature(parent, message)
        : confirmRemoveWallet(parent, SIGNER);
    const first = start();
    await flushConfirmations();
    await assert.rejects(confirmSignature(parent, message), busyError);
    await assert.rejects(confirmRemoveWallet(parent, SIGNER), busyError);
    assert.equal(shown.length, 0);
    await advanceConfirmations(t, ARM_DELAY_MS);
    assert.equal(shown.length, 1);
    await assert.rejects(confirmSignature(parent, message), busyError);
    await assert.rejects(confirmRemoveWallet(parent, SIGNER), busyError);
    click(owner === 'signature' ? 1 : 0);
    assert.equal(await first, true);
    const second = start();
    await flushConfirmations();
    await assert.rejects(confirmSignature(parent, message), busyError);
    await assert.rejects(confirmRemoveWallet(parent, SIGNER), busyError);
    await advanceConfirmations(t, ARM_DELAY_MS - 1);
    assert.equal(shown.length, 1);
    await advanceConfirmations(t, 1);
    assert.equal(shown.length, 2);
    click(owner === 'signature' ? 1 : 0);
    assert.equal(await second, true);
  });
}

for (const response of [0, 1]) {
  for (const offset of [0, 1, 250, 500, 999, 1000, 1001]) {
    test(`request arriving ${offset} ms after response ${response} waits until the arming deadline`, async (t) => {
      const { parent, shown, click } = manualDialogs(t);
      const first = confirmSignature(parent, message);
      await flushConfirmations();
      await advanceConfirmations(t, 2000);
      click(response);
      assert.equal(await first, response === 1);
      const closedAt = Date.now();
      await advanceConfirmations(t, offset);
      const second = confirmRemoveWallet(parent, SIGNER);
      await flushConfirmations();
      assert.equal(shown.length, 1);
      await advanceConfirmations(t, ARM_DELAY_MS - 1);
      assert.equal(shown.length, 1);
      await advanceConfirmations(t, 1);
      assert.equal(shown.length, 2);
      assert.equal(shown[1]?.at, closedAt + offset + ARM_DELAY_MS);
      click(0);
      assert.equal(await second, true);
    });
  }
}

test('a double-click on Next cannot skip a page or reach approval', async (t) => {
  assert.ok(pageCount >= 3);
  const { parent, shown, click } = manualDialogs(t);
  let signed = false;
  const rejected = assert.rejects(
    signWithConfirmation(typed, {
      signer: {
        status: () => Promise.resolve({ unlocked: true, address: SIGNER, unlockExpiresAt: null }),
        sign: () => {
          signed = true;
          return Promise.reject(new Error('unexpected signing'));
        },
      },
      confirm: (req, ctx) => confirmSignature(parent, req, ctx),
    }),
    /user rejected signature/,
  );
  await flushConfirmations();
  await advanceConfirmations(t, ARM_DELAY_MS);
  assert.equal(click(0), true);
  await flushConfirmations();
  await advanceConfirmations(t, 100);
  assert.equal(click(0), false, 'the second click has no dialog to act on');
  await advanceConfirmations(t, 899);
  assert.equal(shown.length, 1);
  await advanceConfirmations(t, 1);
  assert.equal(shown.length, 2);
  assert.match(shown[1]?.options.message ?? '', /^Request \d+, page 2 of /);
  click(1);
  await rejected;
  await advanceConfirmations(t, 2000);
  assert.equal(shown.length, 2);
  assert.equal(signed, false);
});

for (const firstRequest of [message, typed]) {
  test(`a second click after ${firstRequest.kind} closes cannot approve another request`, async (t) => {
    const { parent, shown, click } = manualDialogs(t);
    const first = confirmSignature(parent, firstRequest, context);
    await flushConfirmations();
    await assert.rejects(confirmSignature(parent, message), busyError);
    await advanceConfirmations(t, ARM_DELAY_MS);
    click(1); // Approve a message or cancel the first typed-data page.
    assert.equal(await first, firstRequest.kind === 'message');
    const second = confirmSignature(parent, message);
    await flushConfirmations();
    await advanceConfirmations(t, 100);
    assert.equal(click(1), false);
    await advanceConfirmations(t, 900);
    assert.equal(shown.length, 2);
    click(0);
    assert.equal(await second, false);
  });
}

test('every page has a main-assigned request number and consecutive pages are at least 1000 ms apart', async (t) => {
  const parent = new BrowserWindow();
  const shown: { message: string; detail: string | undefined; at: number }[] = [];
  t.mock.method(dialog, 'showMessageBox', (_owner: unknown, options?: MessageBoxOptions) => {
    assert.ok(options);
    shown.push({ message: options.message, detail: options.detail, at: Date.now() });
    return Promise.resolve({
      response: options.buttons?.includes('Approve & sign') ? 1 : 0,
      checkboxChecked: false,
    });
  });
  for (let requestNumber = 1; requestNumber <= 2; requestNumber++) {
    assert.equal(await finishConfirmation(t, confirmSignature(parent, typed, context)), true);
    const pages = shown.slice((requestNumber - 1) * pageCount, requestNumber * pageCount);
    assert.equal(pages.length, pageCount);
    for (const [index, page] of pages.entries()) {
      assert.ok(
        page.message.startsWith(`Request ${requestNumber}, page ${index + 1} of ${pageCount}\n`),
      );
      assert.doesNotMatch(page.detail ?? '', /^Page \d+ of \d+$/m);
    }
  }
  assert.deepEqual(
    shown.slice(0, pageCount).map((page) => page.detail),
    shown.slice(pageCount).map((page) => page.detail),
  );
  assert.equal(await finishConfirmation(t, confirmRemoveWallet(parent, SIGNER)), true);
  assert.ok(shown.at(-1)?.message.startsWith('Request 3\n'));
  for (const [index, page] of shown.entries()) {
    if (index === 0) continue;
    const previous = shown[index - 1];
    assert.ok(previous);
    assert.equal(page.at - previous.at, ARM_DELAY_MS);
  }
});

const rendererEvents = [
  {
    name: 'reload',
    event: 'did-start-navigation',
    detail: { isMainFrame: true, isSameDocument: false },
    error: /reloaded or navigated/,
  },
  { name: 'navigation', event: 'did-navigate', detail: {}, error: /reloaded or navigated/ },
  { name: 'crash', event: 'render-process-gone', detail: {}, error: /renderer stopped/ },
] as const;

for (const event of rendererEvents) {
  for (const state of ['open', 'arming first page', 'arming next page'] as const) {
    test(`renderer ${event.name} aborts a signature ${state} through the signing failure path`, async (t) => {
      const { parent, shown, click } = manualDialogs(t, true);
      let signed = false;
      const rejected = assert.rejects(
        signWithConfirmation(typed, {
          signer: {
            status: () =>
              Promise.resolve({ unlocked: true, address: SIGNER, unlockExpiresAt: null }),
            sign: () => {
              signed = true;
              return Promise.reject(new Error('unexpected signing'));
            },
          },
          confirm: (req, ctx) => confirmSignature(parent, req, ctx),
        }),
        event.error,
      );
      await flushConfirmations();
      if (state !== 'arming first page') await advanceConfirmations(t, ARM_DELAY_MS);
      if (state === 'arming next page') {
        click(0);
        await flushConfirmations();
      }
      assert.equal(shown.length, state === 'arming first page' ? 0 : 1);
      const openedCount = shown.length;
      parent.webContents.emit(event.event, event.detail);
      await rejected;
      await advanceConfirmations(t, ARM_DELAY_MS * 2);
      assert.equal(shown.length, openedCount);
      assert.equal(signed, false);
      assert.equal(parent.webContents.listenerCount(event.event), 0);
      const fresh = confirmSignature(parent, message);
      await flushConfirmations();
      assert.equal(shown.length, openedCount);
      await advanceConfirmations(t, ARM_DELAY_MS);
      assert.equal(shown.length, openedCount + 1);
      click(0);
      assert.equal(await fresh, false);
    });
  }
  for (const arming of [false, true]) {
    test(`renderer ${event.name} aborts wallet removal (arming: ${arming})`, async (t) => {
      const { parent, shown } = manualDialogs(t);
      const rejected = assert.rejects(confirmRemoveWallet(parent, SIGNER), event.error);
      if (arming) await flushConfirmations();
      else await advanceConfirmations(t, ARM_DELAY_MS);
      parent.webContents.emit(event.event, event.detail);
      await rejected;
      await advanceConfirmations(t, ARM_DELAY_MS * 2);
      assert.equal(shown.length, arming ? 0 : 1);
    });
  }
}

test('subframe and same-document navigation preserve the active request', async (t) => {
  const { parent, shown, click } = manualDialogs(t);
  const approved = confirmSignature(parent, message);
  await flushConfirmations();
  await advanceConfirmations(t, ARM_DELAY_MS);
  parent.webContents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
  parent.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
  assert.equal(shown[0]?.options.signal?.aborted, false);
  click(1);
  assert.equal(await approved, true);
});
