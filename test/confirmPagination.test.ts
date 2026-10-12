import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test, type TestContext } from 'node:test';
import type { MessageBoxOptions } from 'electron';
import {
  SIGNATURE_APPROVAL_NOTE,
  summariseSignatureRequest,
  typedDataDisplayLines,
} from '../src/main/confirmSummary';
import { signWithConfirmation } from '../src/main/signatureRequest';
import { payloadWith, SIGNER, typedRequest } from './typedDataFixtures';
import { RECIPIENTS, reviewRequest, withReviewDomain } from './typedDataReviewFixtures';

register(new URL('./electronMockLoader.mjs', import.meta.url));
const { BrowserWindow, dialog } = await import('electron');
const { confirmSignature } = await import('../src/main/confirm');
const parent = new BrowserWindow();
const request = reviewRequest(withReviewDomain(payloadWith('address[]', RECIPIENTS)));
const context = { connectedChainId: 3151909 };
const expectedPages = summariseSignatureRequest(request, context).pages;

function mockDialogs(t: TestContext, cancelAt = -1, cancelResponse = 1) {
  const shown: MessageBoxOptions[] = [];
  let active = false;
  const mock = t.mock.method(
    dialog,
    'showMessageBox',
    async (owner: unknown, options?: MessageBoxOptions) => {
      assert.equal(owner, parent);
      assert.ok(options);
      assert.equal(active, false, 'native dialogs are awaited sequentially');
      active = true;
      shown.push(options);
      assert.equal(options.defaultId, 1);
      assert.equal(options.cancelId, 1, 'Escape maps to Cancel');
      assert.ok(typedDataDisplayLines(options.detail ?? '') <= 30);
      await Promise.resolve();
      active = false;
      return {
        response: shown.length - 1 === cancelAt ? cancelResponse : 0,
        checkboxChecked: false,
      };
    },
  );
  return { shown, mock };
}

test('native dialogs offer Next in order and Approve only on the last page', async (t) => {
  assert.ok(expectedPages.length > 1);
  const { shown } = mockDialogs(t);
  let signed = false;
  await signWithConfirmation(request, {
    signer: {
      status: async () => ({ unlocked: true, address: SIGNER, unlockExpiresAt: null }),
      sign: async () => {
        assert.equal(shown.length, expectedPages.length);
        signed = true;
        return {
          kind: 'typedData',
          signer: SIGNER,
          signature: '0x02',
          publicKey: '0x00',
          descriptor: '0x010000',
          digest: '0x00',
          schemeVersion: 'QRL-SIGN-TYPED-v2',
        };
      },
    },
    confirm: (req, ctx) => confirmSignature(parent, req, ctx),
  });
  assert.equal(signed, true);
  assert.equal(shown.length, expectedPages.length);
  for (const [i, options] of shown.entries()) {
    assert.deepEqual(options.buttons, [
      i === shown.length - 1 ? 'Approve & sign' : 'Next',
      'Cancel',
    ]);
    assert.equal(options.detail, `${expectedPages[i]}\n\n${SIGNATURE_APPROVAL_NOTE}`);
  }
});

for (let cancelAt = 0; cancelAt < expectedPages.length; cancelAt++) {
  test(`cancelling page ${cancelAt + 1} rejects the entire signing request`, async (t) => {
    const { shown } = mockDialogs(t, cancelAt);
    let signatures = 0;
    await assert.rejects(
      signWithConfirmation(request, {
        signer: {
          status: async () => ({ unlocked: true, address: SIGNER, unlockExpiresAt: null }),
          sign: async () => {
            signatures++;
            throw new Error('unexpected signing');
          },
        },
        confirm: (req, ctx) => confirmSignature(parent, req, ctx),
      }),
      /user rejected signature/,
    );
    assert.equal(shown.length, cancelAt + 1);
    assert.equal(signatures, 0);
  });
}

test('an unexpected native response cancels without opening subsequent pages', async (t) => {
  const { shown } = mockDialogs(t, 0, -1);
  assert.equal(await confirmSignature(parent, request, context), false);
  assert.equal(shown.length, 1);
});

test('a single-page request offers approval immediately', async (t) => {
  const { shown } = mockDialogs(t);
  assert.equal(
    await confirmSignature(parent, typedRequest(payloadWith('string', 'hello')), context),
    true,
  );
  assert.equal(shown.length, 1);
  assert.deepEqual(shown[0]?.buttons, ['Approve & sign', 'Cancel']);
  assert.match(shown[0]?.detail ?? '', /Page 1 of 1/);
});

test('more than ten pages refuses before opening a dialog or signing', async (t) => {
  const { shown } = mockDialogs(t);
  const oversized = reviewRequest(
    payloadWith(
      'uint8[]',
      Array.from({ length: 256 }, () => 1),
    ),
  );
  let signatures = 0;
  await assert.rejects(
    signWithConfirmation(oversized, {
      signer: {
        status: async () => ({ unlocked: true, address: SIGNER, unlockExpiresAt: null }),
        sign: async () => {
          signatures++;
          throw new Error('unexpected signing');
        },
      },
      confirm: (req, ctx) => confirmSignature(parent, req, ctx),
    }),
    /too large to review safely on desktop \(maximum 10 pages\)/,
  );
  assert.equal(shown.length, 0);
  assert.equal(signatures, 0);
});

test('oversized mandatory metadata refuses before opening a dialog', async (t) => {
  const { shown } = mockDialogs(t);
  const payload = payloadWith();
  payload.domain['name'] = 'x'.repeat(16 * 1024);
  await assert.rejects(
    confirmSignature(parent, reviewRequest(payload), context),
    /security details exceed/,
  );
  assert.equal(shown.length, 0);
});

test('exactly ten pages can be reviewed and the next row fails closed', async (t) => {
  let largest = typedRequest(payloadWith('uint8[]', []));
  let rowCount = 0;
  for (let count = 1; count <= 256; count++) {
    const candidate = typedRequest(
      payloadWith(
        'uint8[]',
        Array.from({ length: count }, () => 1),
      ),
    );
    try {
      summariseSignatureRequest(candidate, context);
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.match(error.message, /too large to review safely/);
      rowCount = count - 1;
      break;
    }
    largest = candidate;
  }
  assert.ok(rowCount > 0);
  assert.equal(summariseSignatureRequest(largest, context).pages.length, 10);
  const { shown } = mockDialogs(t);
  assert.equal(await confirmSignature(parent, largest, context), true);
  assert.equal(shown.length, 10);
  const oversized = typedRequest(
    payloadWith(
      'uint8[]',
      Array.from({ length: rowCount + 1 }, () => 1),
    ),
  );
  await assert.rejects(confirmSignature(parent, oversized, context), /maximum 10 pages/);
  assert.equal(shown.length, 10);
});
