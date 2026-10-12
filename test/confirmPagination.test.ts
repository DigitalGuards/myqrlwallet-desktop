import assert from 'node:assert/strict';
import { register } from 'node:module';
import { beforeEach, test, type TestContext } from 'node:test';
import type { MessageBoxOptions } from 'electron';
import type { SignatureRequest } from '../src/shared/schemas';
import {
  SIGNATURE_APPROVAL_NOTE,
  summariseSignatureRequest,
  typedDataDisplayLines,
} from '../src/main/confirmSummary';
import { signWithConfirmation } from '../src/main/signatureRequest';
import { payloadWith, SIGNER, typedRequest } from './typedDataFixtures';
import { RECIPIENTS, reviewRequest, withReviewDomain } from './typedDataReviewFixtures';
import { finishConfirmation, mockConfirmationClock } from './confirmationClock';

register(new URL('./electronMockLoader.mjs', import.meta.url));
const { BrowserWindow, dialog } = await import('electron');
const { confirmSignature, confirmRemoveWallet } = await import('../src/main/confirm');
const parent = new BrowserWindow();
const request = reviewRequest(withReviewDomain(payloadWith('address[]', RECIPIENTS)));
const context = { connectedChainId: 3151909 };
const expectedPages = summariseSignatureRequest(request, context).pages;
beforeEach(mockConfirmationClock);

function mockDialogs(t: TestContext, cancelAt = -1, cancelResponse?: number) {
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
      const approvalId = options.buttons?.indexOf('Approve & sign');
      const cancelId = options.buttons?.indexOf('Cancel');
      assert.equal(options.defaultId, cancelId);
      assert.equal(options.cancelId, cancelId, 'Escape maps to Cancel');
      if (options.title === 'Confirm typed-data signature')
        assert.ok(typedDataDisplayLines(options.detail ?? '') <= 30);
      await Promise.resolve();
      active = false;
      return {
        response:
          shown.length - 1 === cancelAt ? (cancelResponse ?? cancelId) : approvalId === 1 ? 1 : 0,
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
  await finishConfirmation(
    t,
    signWithConfirmation(request, {
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
    }),
  );
  assert.equal(signed, true);
  assert.equal(shown.length, expectedPages.length);
  for (const [i, options] of shown.entries()) {
    assert.deepEqual(
      options.buttons,
      i === shown.length - 1 ? ['Cancel', 'Approve & sign'] : ['Next', 'Cancel'],
    );
    assert.equal(options.detail, `${expectedPages[i]}\n\n${SIGNATURE_APPROVAL_NOTE}`);
  }
});

for (let cancelAt = 0; cancelAt < expectedPages.length; cancelAt++) {
  test(`cancelling page ${cancelAt + 1} rejects the entire signing request`, async (t) => {
    const { shown } = mockDialogs(t, cancelAt);
    let signatures = 0;
    await finishConfirmation(
      t,
      assert.rejects(
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
      ),
    );
    assert.equal(shown.length, cancelAt + 1);
    assert.equal(signatures, 0);
  });
}

for (const page of [0, expectedPages.length - 1]) {
  for (const response of [-1, 2]) {
    test(`unexpected response ${response} on page ${page + 1} cancels`, async (t) => {
      const { shown } = mockDialogs(t, page, response);
      assert.equal(await finishConfirmation(t, confirmSignature(parent, request, context)), false);
      assert.equal(shown.length, page + 1);
    });
  }
}

test('repeating the Next button index on the final page cancels', async (t) => {
  const { shown } = mockDialogs(t, expectedPages.length - 1, 0);
  assert.equal(await finishConfirmation(t, confirmSignature(parent, request, context)), false);
  assert.equal(shown.length, expectedPages.length);
});

test('a single-page request offers approval immediately', async (t) => {
  const { shown } = mockDialogs(t);
  assert.equal(
    await finishConfirmation(
      t,
      confirmSignature(parent, typedRequest(payloadWith('string', 'hello')), context),
    ),
    true,
  );
  assert.equal(shown.length, 1);
  assert.deepEqual(shown[0]?.buttons, ['Cancel', 'Approve & sign']);
  assert.match(shown[0]?.detail ?? '', /Page 1 of 1/);
});

for (const cancelAt of [-1, 0, expectedPages.length - 1]) {
  test(`concurrent signatures and wallet removal are refused (cancel at ${cancelAt})`, async (t) => {
    const { shown } = mockDialogs(t, cancelAt);
    const message: SignatureRequest = { kind: 'message', signer: SIGNER, messageHex: '0x01' };
    const transaction: SignatureRequest = {
      kind: 'transaction',
      tx: {
        from: SIGNER,
        to: SIGNER,
        value: '0',
        nonce: 0,
        gas: '21000',
        maxFeePerGas: '1',
        maxPriorityFeePerGas: '1',
        chainId: 3151909,
        type: '0x2',
      },
    };
    const firstPageCount = cancelAt === -1 ? expectedPages.length : cancelAt + 1;
    const first = confirmSignature(parent, request, context);
    await Promise.all(
      [
        confirmSignature(parent, request, context),
        confirmRemoveWallet(parent, SIGNER),
        confirmSignature(parent, message),
        confirmSignature(parent, transaction),
      ].map((pending) => assert.rejects(pending, /another confirmation is already open/)),
    );
    assert.equal(await finishConfirmation(t, first), cancelAt === -1);
    const typedPages = expectedPages.slice(0, firstPageCount);
    assert.deepEqual(
      shown.map(({ detail }) => detail),
      typedPages.map((detail) => `${detail}\n\n${SIGNATURE_APPROVAL_NOTE}`),
    );
  });
}

test('a native dialog failure rejects its request and releases the busy slot', async (t) => {
  const { shown, mock } = mockDialogs(t);
  mock.mock.mockImplementationOnce(async () => {
    throw new Error('native dialog failed');
  });
  const rejected = assert.rejects(
    confirmSignature(parent, request, context),
    /native dialog failed/,
  );
  await rejected;
  assert.equal(await finishConfirmation(t, confirmRemoveWallet(parent, SIGNER)), true);
  assert.equal(shown.length, 1);
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
  assert.equal(await finishConfirmation(t, confirmSignature(parent, largest, context)), true);
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
