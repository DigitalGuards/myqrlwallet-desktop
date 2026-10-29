import assert from 'node:assert/strict';
import { register } from 'node:module';
import { beforeEach, test, type TestContext } from 'node:test';
import type { MessageBoxOptions } from 'electron';
import { SignatureRequestSchema, type SignatureRequest } from '../src/shared/schemas';
import {
  DETAIL_LINE_COLUMNS,
  SIGNATURE_APPROVAL_NOTE,
  summariseSignatureRequest,
  typedDataDisplayLines,
  wrapDetailText,
} from '../src/main/confirmSummary';
import { signWithConfirmation } from '../src/main/signatureRequest';
import { payloadWith, SIGNER, typedRequest } from './typedDataFixtures';
import {
  RECIPIENTS,
  REVIEW_ORIGIN,
  reviewRequest,
  withReviewDomain,
} from './typedDataReviewFixtures';
import { finishConfirmation, mockConfirmationClock } from './confirmationClock';
import { DIALOG_CHROME_MESSAGE, messageRequest, QUANTASWAP_MESSAGE } from './messageReviewFixtures';

import { assertDetailWidth, assertTrustedLineStarts, unfoldDetail } from './confirmLayout';
import { groupQrlAddress } from '../src/shared/address';
import { vaultBatchPayload, vaultPayload, vaultCalldata } from './quantaVaultFixtures';
import { VAULT_MAX_UINT256 } from '../src/shared/quantaVault';
import { isRecord } from '../src/shared/guards';

register(new URL('./electronMockLoader.mjs', import.meta.url));
const { BrowserWindow, dialog } = await import('electron');
const { confirmSignature, confirmRemoveWallet } = await import('../src/main/confirm');
const parent = new BrowserWindow();
const request = reviewRequest(withReviewDomain(payloadWith('address[]', RECIPIENTS)));
const context = { connectedChainId: 3151909 };
const expectedPages = summariseSignatureRequest(request, context).pages;
const message = messageRequest(QUANTASWAP_MESSAGE, REVIEW_ORIGIN);
const expectedMessagePages = summariseSignatureRequest(message).pages;
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
      assertDetailWidth(options.detail ?? '');
      assertTrustedLineStarts(options.detail ?? '');
      assert.doesNotMatch(options.detail ?? '', /^Page \d+ of \d+$/m);
      const approvalId = options.buttons?.indexOf('Approve & sign');
      const cancelId = options.buttons?.indexOf('Cancel');
      assert.equal(options.defaultId, cancelId);
      assert.equal(options.cancelId, cancelId, 'Escape maps to Cancel');
      if (
        options.title === 'Confirm typed-data signature' ||
        options.title === 'Confirm message signature'
      )
        assert.ok(typedDataDisplayLines(options.detail ?? '') <= 30);
      if (options.title === 'Confirm message signature') {
        const lines = (options.detail ?? '').split('\n');
        const heading = lines.findIndex((line) =>
          /^Message \((?:text|hex), \d+ bytes\):$/.test(line),
        );
        assert.ok(heading >= 0);
        const note = ['', ...wrapDetailText(SIGNATURE_APPROVAL_NOTE).split('\n')];
        assert.deepEqual(lines.slice(-note.length), note);
        const body = lines.slice(heading + 1, -note.length);
        assert.ok(body.length > 0);
        assert.ok(body.every((line) => line.startsWith('\u200e| ')));
      }
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

for (const [label, payload] of [
  ['decoded batch', vaultBatchPayload(5)],
  ['collapsed batch', vaultBatchPayload(50)],
  ['nested approval', vaultPayload('approval-empty')],
  ['opaque message', vaultPayload('digest-message')],
] as const) {
  const vaultRequest = typedRequest(payload);
  for (const cancellation of ['approve', 'first', 'last'] as const) {
    test(`vault ${label} confirmation handoff: ${cancellation}`, async (t) => {
      const vaultPages = summariseSignatureRequest(vaultRequest, context).pages;
      const cancelAt =
        cancellation === 'approve' ? -1 : cancellation === 'first' ? 0 : vaultPages.length - 1;
      const { shown } = mockDialogs(t, cancelAt);
      let signatures = 0;
      const pending = signWithConfirmation(vaultRequest, {
        signer: {
          status: () => Promise.resolve({ unlocked: true, address: SIGNER, unlockExpiresAt: null }),
          sign: (received) => {
            assert.equal(received, vaultRequest);
            assert.equal(shown.length, vaultPages.length);
            signatures++;
            return Promise.resolve({
              kind: 'typedData',
              signer: SIGNER,
              signature: '0x02',
              publicKey: '0x00',
              descriptor: '0x010000',
              digest: '0x00',
              schemeVersion: 'QRL-SIGN-TYPED-v2',
            });
          },
        },
        confirm: (req, ctx) => confirmSignature(parent, req, ctx),
      });
      if (cancelAt === -1) await finishConfirmation(t, pending);
      else await finishConfirmation(t, assert.rejects(pending, /user rejected signature/));
      assert.equal(signatures, cancelAt === -1 ? 1 : 0);
      assert.equal(shown.length, cancelAt === -1 ? vaultPages.length : cancelAt + 1);
      for (const [index, options] of shown.entries()) {
        assert.equal(
          options.detail,
          wrapDetailText(`${vaultPages[index]}\n\n${SIGNATURE_APPROVAL_NOTE}`),
        );
        assert.deepEqual(
          options.buttons,
          index === vaultPages.length - 1 ? ['Cancel', 'Approve & sign'] : ['Next', 'Cancel'],
        );
      }
    });
  }
}

test('native dialogs offer Next in order and Approve only on the last page', async (t) => {
  assert.ok(expectedPages.length > 1);
  const { shown } = mockDialogs(t);
  let signed = false;
  await finishConfirmation(
    t,
    signWithConfirmation(request, {
      signer: {
        status: () => Promise.resolve({ unlocked: true, address: SIGNER, unlockExpiresAt: null }),
        sign: () => {
          assert.equal(shown.length, expectedPages.length);
          signed = true;
          return Promise.resolve({
            kind: 'typedData',
            signer: SIGNER,
            signature: '0x02',
            publicKey: '0x00',
            descriptor: '0x010000',
            digest: '0x00',
            schemeVersion: 'QRL-SIGN-TYPED-v2',
          });
        },
      },
      confirm: (req, ctx) => confirmSignature(parent, req, ctx),
    }),
  );
  assert.equal(signed, true);
  assert.equal(shown.length, expectedPages.length);
  for (const [i, options] of shown.entries()) {
    assert.equal(options.message.split('\n')[0], `Request 1, page ${i + 1} of ${shown.length}`);
    assert.deepEqual(
      options.buttons,
      i === shown.length - 1 ? ['Cancel', 'Approve & sign'] : ['Next', 'Cancel'],
    );
    assert.equal(
      options.detail,
      wrapDetailText(`${expectedPages[i]}\n\n${SIGNATURE_APPROVAL_NOTE}`),
    );
  }
});

test('retained vault rows approve at ten pages and fail closed when the reduced review exceeds the cap', async (t) => {
  const payload = vaultPayload('approval-empty');
  const tx = payload.message['tx'];
  assert.ok(isRecord(tx));
  tx['data'] = vaultCalldata('execTransaction').data;
  tx['operation'] = 2;
  for (const field of ['txGas', 'nonce', 'value']) tx[field] = VAULT_MAX_UINT256.toString();
  const request = SignatureRequestSchema.parse({
    ...typedRequest(payload),
    origin: { via: 'dapp', name: 'W'.repeat(48), url: '', channelId: 'abcdef01' },
  });
  const pages = summariseSignatureRequest(request).pages;
  assert.equal(pages.length, 10);
  assert.ok(pages.some((page) => unfoldDetail(page).includes('decoding omitted')));
  const { shown } = mockDialogs(t);
  assert.equal(await finishConfirmation(t, confirmSignature(parent, request)), true);
  assert.equal(shown.length, 10);
  const oversized = SignatureRequestSchema.parse({
    ...request,
    origin: { ...request.origin, name: 'W'.repeat(64) },
  });
  const sign = t.mock.fn(() => Promise.reject(new Error('unexpected signing')));
  await assert.rejects(
    signWithConfirmation(oversized, {
      signer: {
        status: () => Promise.resolve({ unlocked: true, address: SIGNER, unlockExpiresAt: null }),
        sign,
      },
      confirm: (req, ctx) => confirmSignature(parent, req, ctx),
    }),
    /maximum 10 pages/,
  );
  assert.equal(shown.length, 10, 'overflow opens no additional dialogs');
  assert.equal(sign.mock.callCount(), 0);
});

test('message signing requires every page and offers Approve only on the last page', async (t) => {
  assert.ok(expectedMessagePages.length > 1);
  const { shown } = mockDialogs(t);
  let signatures = 0;
  await finishConfirmation(
    t,
    signWithConfirmation(message, {
      signer: {
        status: () => Promise.resolve({ unlocked: true, address: SIGNER, unlockExpiresAt: null }),
        sign: (req) => {
          assert.deepEqual(req, message);
          assert.equal(shown.length, expectedMessagePages.length);
          signatures++;
          return Promise.resolve({
            kind: 'message',
            signer: SIGNER,
            signature: '0x02',
            publicKey: '0x00',
            descriptor: '0x010000',
            digest: '0x00',
            schemeVersion: 'QRL-SIGN-MSG-v1',
          });
        },
      },
      confirm: (req, ctx) => confirmSignature(parent, req, ctx),
    }),
  );
  assert.equal(signatures, 1);
  for (const [index, options] of shown.entries()) {
    assert.equal(options.message.split('\n')[0], `Request 1, page ${index + 1} of ${shown.length}`);
    assert.deepEqual(
      options.buttons,
      index === shown.length - 1 ? ['Cancel', 'Approve & sign'] : ['Next', 'Cancel'],
    );
    assert.equal(
      options.detail,
      wrapDetailText(`${expectedMessagePages[index]}\n\n${SIGNATURE_APPROVAL_NOTE}`),
    );
  }
});

for (let cancelAt = 0; cancelAt < expectedMessagePages.length; cancelAt++) {
  test(`cancelling message page ${cancelAt + 1} prevents signing`, async (t) => {
    const { shown } = mockDialogs(t, cancelAt);
    let signatures = 0;
    await finishConfirmation(
      t,
      assert.rejects(
        signWithConfirmation(message, {
          signer: {
            status: () =>
              Promise.resolve({ unlocked: true, address: SIGNER, unlockExpiresAt: null }),
            sign: () => {
              signatures++;
              return Promise.reject(new Error('unexpected signing'));
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

for (const [label, value] of [
  ['short', 'hello'],
  ['empty', ''],
  ['forged dialog chrome', DIALOG_CHROME_MESSAGE],
] as const) {
  test(`${label} message offers approval on its only page`, async (t) => {
    const { shown } = mockDialogs(t);
    assert.equal(
      await finishConfirmation(t, confirmSignature(parent, messageRequest(value))),
      true,
    );
    assert.equal(shown.length, 1);
    assert.deepEqual(shown[0]?.buttons, ['Cancel', 'Approve & sign']);
    assert.match(shown[0].message, /^Request \d+\n/);
  });
}

for (const [label, value] of [
  ['ASCII', 'a'.repeat(64 * 1024 - 1)],
  ['escaped controls', '\0'.repeat(4096)],
  ['binary', new Uint8Array(16 * 1024).fill(0xff)],
] as const) {
  test(`oversized message review (${label}) refuses before opening a dialog or signing`, async (t) => {
    const { shown } = mockDialogs(t);
    let signatures = 0;
    await assert.rejects(
      signWithConfirmation(messageRequest(value), {
        signer: {
          status: () => Promise.resolve({ unlocked: true, address: SIGNER, unlockExpiresAt: null }),
          sign: () => {
            signatures++;
            return Promise.reject(new Error('unexpected signing'));
          },
        },
        confirm: (req, ctx) => confirmSignature(parent, req, ctx),
      }),
      /message too long to review in the trusted dialog/,
    );
    assert.equal(shown.length, 0);
    assert.equal(signatures, 0);
  });
}

test('exactly ten message pages can be approved and one more byte refuses before a dialog', async (t) => {
  let accepted = 0;
  let rejected = 64 * 1024 - 1;
  while (rejected - accepted > 1) {
    const bytes = Math.floor((accepted + rejected) / 2);
    try {
      summariseSignatureRequest(messageRequest('a'.repeat(bytes)));
      accepted = bytes;
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.match(error.message, /message too long to review in the trusted dialog/);
      rejected = bytes;
    }
  }
  assert.equal(
    accepted % (DETAIL_LINE_COLUMNS - 2),
    0,
    'the page cap ends on a complete content row',
  );
  const largest = messageRequest('a'.repeat(accepted));
  assert.equal(summariseSignatureRequest(largest).pages.length, 10);
  const { shown } = mockDialogs(t);
  assert.equal(await finishConfirmation(t, confirmSignature(parent, largest)), true);
  assert.equal(shown.length, 10);
  await assert.rejects(
    confirmSignature(parent, messageRequest('a'.repeat(accepted + 1))),
    /message too long to review in the trusted dialog/,
  );
  assert.equal(shown.length, 10);
});

test('transaction values and wallet-removal addresses fit the shared detail width', async (t) => {
  const { shown } = mockDialogs(t);
  const gas = '9'.repeat(18);
  const transaction = SignatureRequestSchema.parse({
    kind: 'transaction',
    tx: {
      from: SIGNER,
      to: SIGNER,
      value: '9'.repeat(80),
      nonce: Number.MAX_SAFE_INTEGER,
      gas,
      maxFeePerGas: '9'.repeat(80),
      maxPriorityFeePerGas: '9'.repeat(80),
      chainId: Number.MAX_SAFE_INTEGER,
      type: '0x2',
      data: `0x${'ab'.repeat(100)}`,
    },
    origin: {
      ...REVIEW_ORIGIN,
      name: 'MW@%'.repeat(16),
      url: `https://dapp.example/${'界'.repeat(100)}`,
      channelId: 'a'.repeat(64),
    },
  });
  for (const context of [
    {},
    { blockGasLimit: 30_000_000n },
    { build: { estimatedGas: gas } },
    { build: { estimatedGas: '21000', requestedGas: gas } },
    { build: { estimatedGas: gas, requestedGas: '21000' } },
    { build: { estimatedGas: (BigInt(gas) + 1n).toString(), requestedGas: '21000' } },
  ]) {
    const firstPage = shown.length;
    assert.equal(await finishConfirmation(t, confirmSignature(parent, transaction, context)), true);
    const detail = shown
      .slice(firstPage)
      .map((page) => unfoldDetail(page.detail ?? ''))
      .join('\n');
    assert.ok(detail.includes(`To:        ${groupQrlAddress(SIGNER)}`));
    assert.ok(detail.includes('Name:    MW@%'));
    assert.match(shown.at(-1)?.message ?? '', /^Request \d+, page \d+ of \d+\n/);
  }
  assert.equal(await finishConfirmation(t, confirmRemoveWallet(parent, SIGNER)), true);
  assert.ok(
    unfoldDetail(shown.at(-1)?.detail ?? '').includes(`Account: ${groupQrlAddress(SIGNER)}`),
  );
  assert.match(shown.at(-1)?.message ?? '', /^Request \d+\n/);
});

test('spoofed origin metadata stays on labelled rows and marked continuations', async (t) => {
  const origin = {
    ...REVIEW_ORIGIN,
    name: `${' '.repeat(34)}Page 1 of 1`,
    url: `https://dapp.example/${' '.repeat(12)}Account: forged\u200b`,
  };
  const { shown } = mockDialogs(t);
  for (const request of [
    messageRequest(DIALOG_CHROME_MESSAGE, origin),
    SignatureRequestSchema.parse({
      ...typedRequest(payloadWith('string', DIALOG_CHROME_MESSAGE)),
      origin,
    }),
  ]) {
    assert.equal(await finishConfirmation(t, confirmSignature(parent, request)), true);
  }
  for (const { detail = '' } of shown) {
    assert.equal(detail.includes('\u200b'), false);
    assert.doesNotMatch(detail, /^Account: forged|^Page 1 of 1/m);
    assert.ok(unfoldDetail(detail).includes('Account: forged\\u200b'));
  }
});

test('overwide typed-data metadata refuses before opening a dialog or signing', async (t) => {
  const payload = withReviewDomain(payloadWith());
  payload.domain['name'] = 'n'.repeat(250);
  const { shown } = mockDialogs(t);
  let signatures = 0;
  await assert.rejects(
    signWithConfirmation(reviewRequest(payload), {
      signer: {
        status: () => Promise.resolve({ unlocked: true, address: SIGNER, unlockExpiresAt: null }),
        sign: () => {
          signatures++;
          return Promise.reject(new Error('unexpected signing'));
        },
      },
      confirm: (req, ctx) => confirmSignature(parent, req, ctx),
    }),
    /security details exceed the confirmation display limit/,
  );
  assert.equal(shown.length, 0);
  assert.equal(signatures, 0);
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
            status: () =>
              Promise.resolve({ unlocked: true, address: SIGNER, unlockExpiresAt: null }),
            sign: () => {
              signatures++;
              return Promise.reject(new Error('unexpected signing'));
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

test('a single-page request offers approval on its only page', async (t) => {
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
  assert.match(shown[0].message, /^Request \d+\n/);
});

test('message, typed-data and removal dialogs keep short questions in their bold labels', async (t) => {
  const { shown } = mockDialogs(t);
  for (const request of [messageRequest('hello'), typedRequest(payloadWith('string', 'hello'))]) {
    assert.equal(await finishConfirmation(t, confirmSignature(parent, request, context)), true);
  }
  assert.equal(await finishConfirmation(t, confirmRemoveWallet(parent, SIGNER)), true);
  const questions = shown.map(({ message }) => message.split('\n').slice(1).join('\n'));
  assert.deepEqual(questions, [
    'Sign this message with your wallet key?',
    'Sign this structured data with your wallet key?',
    'Permanently remove this wallet from this device?',
  ]);
  assert.ok(questions.every((question) => question.length <= 48));
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
      typedPages.map((detail) => wrapDetailText(`${detail}\n\n${SIGNATURE_APPROVAL_NOTE}`)),
    );
  });
}

test('a native dialog failure rejects its request and releases the busy slot', async (t) => {
  const { shown, mock } = mockDialogs(t);
  mock.mock.mockImplementationOnce(() => {
    return Promise.reject(new Error('native dialog failed'));
  });
  const rejected = assert.rejects(
    confirmSignature(parent, request, context),
    /native dialog failed/,
  );
  await finishConfirmation(t, rejected);
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
        status: () => Promise.resolve({ unlocked: true, address: SIGNER, unlockExpiresAt: null }),
        sign: () => {
          signatures++;
          return Promise.reject(new Error('unexpected signing'));
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
