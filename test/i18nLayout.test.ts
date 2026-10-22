import assert from 'node:assert/strict';
import { test } from 'node:test';
import { register } from 'node:module';
import type { MessageBoxOptions } from 'electron';
import { LANGUAGES } from '../src/shared/language';
import { translate } from '../src/shared/i18n';
import {
  summariseSignatureRequest,
  wrapDetailText,
  TYPED_DATA_DISPLAY_LIMITS,
} from '../src/main/confirmSummary';
import { reviewCases, reviewRequest, REVIEW_ORIGIN } from './typedDataReviewFixtures';
import { messageRequest, DIALOG_CHROME_MESSAGE, QUANTASWAP_MESSAGE } from './messageReviewFixtures';
import { assertDetailWidth, unfoldDetail } from './confirmLayout';
import { mockConfirmationClock, finishConfirmation } from './confirmationClock';
import { SIGNER } from './typedDataFixtures';
import { SignatureRequestSchema } from '../src/shared/schemas';

register(new URL('./electronMockLoader.mjs', import.meta.url));
const { BrowserWindow, dialog } = await import('electron');
const { applyLanguage } = await import('../src/main/language');
const { confirmSignature, confirmRemoveWallet } = await import('../src/main/confirm');

function checkMarkers(detail: string) {
  let untrusted = false;
  for (const line of detail.split('\n')) {
    if (line.startsWith('\u200e    | '))
      assert.ok(untrusted, 'marked continuation retains its source');
    else if (line.startsWith('    '))
      assert.equal(untrusted, false, 'dApp continuation cannot become a wallet label');
    else untrusted = line.startsWith('\u200e');
    assert.ok(!line.slice(1).includes('\u200e'), 'only main supplies raw direction marks');
  }
}

for (const language of LANGUAGES) {
  test(`${language}: longest transaction warnings, amounts and origin fit complete rows on bounded pages`, () => {
    const request = SignatureRequestSchema.parse({
      kind: 'transaction',
      origin: REVIEW_ORIGIN,
      tx: {
        type: '0x2',
        from: SIGNER,
        to: SIGNER,
        value: '9'.repeat(80),
        nonce: 42,
        gas: '2000000',
        maxFeePerGas: '9'.repeat(80),
        maxPriorityFeePerGas: '1',
        chainId: 3151909,
        data: '0x' + 'ab'.repeat(100),
      },
    });
    const before = structuredClone(request);
    const summary = summariseSignatureRequest(
      request,
      { build: { estimatedGas: '21000', requestedGas: '2000000' } },
      language,
    );
    assert.deepEqual(request, before);
    assert.ok(summary.pages.length > 1);
    assert.ok(summary.pages.length <= 10);
    for (const page of summary.pages) {
      const detail = wrapDetailText(`${page}\n\n${translate(language, 'confirm.approvalNote')}`);
      assertDetailWidth(detail);
      checkMarkers(detail);
      assert.ok(detail.split('\n').length <= 30);
    }
    const logical = summary.pages.map(unfoldDetail).join('\n');
    assert.ok(logical.includes(translate(language, 'confirm.refund')));
    assert.ok(logical.includes(REVIEW_ORIGIN.url));
    assert.ok(logical.includes('0x' + 'ab'.repeat(32)));
  });
  test(`${language}: every typed-data fixture fits the 48-column / 30-line / 10-page limits`, () => {
    for (const item of reviewCases) {
      const summary = summariseSignatureRequest(
        reviewRequest(item.payload),
        { connectedChainId: 3151909 },
        language,
      );
      assert.ok(summary.pages.length <= TYPED_DATA_DISPLAY_LIMITS.pages, item.label);
      const logical = summary.pages.map(unfoldDetail).join('\n');
      assert.ok(
        logical.includes(`${translate(language, 'confirm.name')} `),
        'origin labels retain a separator',
      );
      for (const field of item.paths)
        assert.equal(logical.split(`${field} (`).length - 1, 1, field);
      for (const page of summary.pages) {
        const detail = wrapDetailText(`${page}\n\n${translate(language, 'confirm.approvalNote')}`);
        assertDetailWidth(detail);
        checkMarkers(detail);
        assert.ok(detail.split('\n').length <= 30, `${item.label}: ${detail}`);
      }
    }
  });

  test(`${language}: complete message bytes and forged chrome stay inside the gutter`, () => {
    for (const body of [
      QUANTASWAP_MESSAGE,
      DIALOG_CHROME_MESSAGE,
      'Кошелёк 简体中文 \\ "\n\u200e\u202e'.repeat(15),
    ]) {
      const summary = summariseSignatureRequest(messageRequest(body, REVIEW_ORIGIN), {}, language);
      const rows: string[] = [];
      for (const page of summary.pages) {
        const detail = wrapDetailText(`${page}\n\n${translate(language, 'confirm.approvalNote')}`);
        assertDetailWidth(detail);
        checkMarkers(detail);
        assert.ok(detail.split('\n').length <= 30);
        rows.push(
          ...page
            .split('\n')
            .filter((line) => line.startsWith('\u200e| '))
            .map((line) => line.slice(3)),
        );
      }
      const escaped = rows.join('');
      const decoded: unknown = JSON.parse(`"${escaped.replaceAll('"', '\\"')}"`);
      assert.equal(decoded, body);
    }
    assert.throws(
      () => summariseSignatureRequest(messageRequest('x'.repeat(16384)), {}, language),
      { message: translate(language, 'error.messageLong', { pages: 10 }) },
    );
  });

  test(`${language}: native buttons, request counters, removal and final-page approval`, async (t) => {
    await mockConfirmationClock(t);
    applyLanguage(language);
    t.after(() => applyLanguage('en'));
    const shown: MessageBoxOptions[] = [];
    t.mock.method(dialog, 'showMessageBox', (_owner: unknown, options?: MessageBoxOptions) => {
      assert.ok(options);
      shown.push(options);
      assertDetailWidth(options.detail ?? '');
      checkMarkers(options.detail ?? '');
      return Promise.resolve({
        response: options.buttons?.includes(translate(language, 'confirm.approve')) ? 1 : 0,
        checkboxChecked: false,
      });
    });
    const parent = new BrowserWindow();
    assert.equal(
      await finishConfirmation(
        t,
        confirmSignature(parent, messageRequest(QUANTASWAP_MESSAGE, REVIEW_ORIGIN)),
      ),
      true,
    );
    assert.ok(shown.length > 1);
    shown.forEach((options, i) => {
      const last = i === shown.length - 1;
      assert.equal(options.defaultId, last ? 0 : 1);
      assert.equal(options.cancelId, last ? 0 : 1);
      assert.deepEqual(
        options.buttons,
        last
          ? [translate(language, 'common.cancel'), translate(language, 'confirm.approve')]
          : [translate(language, 'common.next'), translate(language, 'common.cancel')],
      );
      assert.ok(
        options.message.startsWith(
          translate(language, 'confirm.page', { number: 1, page: i + 1, pages: shown.length }),
        ),
      );
    });
    shown.length = 0;
    assert.equal(await finishConfirmation(t, confirmRemoveWallet(parent, SIGNER)), true);
    const removal = shown.at(0);
    assert.ok(removal);
    assert.equal(removal.title, translate(language, 'remove.title'));
    assert.equal(removal.defaultId, 1);
    assert.ok(removal.message.startsWith(translate(language, 'confirm.request', { number: 2 })));
  });
}
