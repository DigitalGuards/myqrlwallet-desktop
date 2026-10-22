import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { test } from 'node:test';
import { z } from 'zod';
import type { MessageBoxOptions } from 'electron';
import {
  summariseSignatureRequest,
  wrapDetailText,
  type ConfirmSummary,
} from '../src/main/confirmSummary';
import { translate, type MessageKey } from '../src/shared/i18n';
import { LANGUAGES, type Language } from '../src/shared/language';
import { confirmationReviewCases } from './confirmationReviewCases';
import { unfoldDetail } from './confirmLayout';
import { finishConfirmation, mockConfirmationClock } from './confirmationClock';

const oracle = z
  .object({
    revision: z.string(),
    sourceSha256: z.string(),
    cases: z.array(
      z.object({
        name: z.string(),
        error: z.string().optional(),
        summary: z
          .object({ title: z.string(), message: z.string(), pages: z.array(z.string()) })
          .optional(),
        details: z.array(z.string()).optional(),
      }),
    ),
  })
  .parse(
    JSON.parse(
      readFileSync(new URL('./fixtures/confirmation-origin-dev.json', import.meta.url), 'utf8'),
    ),
  );
const cases = confirmationReviewCases();

test('the pinned origin/dev oracle covers every review fixture in order', () => {
  assert.equal(oracle.revision, '0a6d581795d9c061560991ead7a260f31d87ba8d');
  assert.deepEqual(
    cases.map(({ name }) => name),
    oracle.cases.map(({ name }) => name),
  );
});

for (const [index, fixture] of cases.entries()) {
  test(`English origin/dev bytes and acceptance: ${fixture.name}`, () => {
    const expected = oracle.cases[index];
    assert.ok(expected);
    if (expected.error !== undefined) {
      assert.throws(() => summariseSignatureRequest(fixture.request, fixture.context), {
        message: expected.error,
      });
    } else {
      assert.deepEqual(
        summariseSignatureRequest(fixture.request, fixture.context),
        expected.summary,
      );
    }
  });
}

function logicalRows(summary: ConfirmSummary): string[] {
  return summary.pages.flatMap((page) => unfoldDetail(page).split('\n'));
}

/** Strip only the wallet-owned length annotation after a quoted preview. */
const sourcePreview = (value: string) => value.replace(/(…") \[[^\]]*\]$/u, '$1');

function labelledValues(rows: string[], prefix: string): string[] {
  // Repeated page headers contain the same value; message fields remain ordered.
  return [
    ...new Set(
      rows
        .filter((line) => line.startsWith(prefix))
        .map((line) => sourcePreview(line.slice(prefix.length))),
    ),
  ];
}

function shownFacts(summary: ConfirmSummary, language: Language, kind: string): unknown {
  const rows = logicalRows(summary);
  const t = (key: MessageKey) => translate(language, key);
  const pad = (key: MessageKey, width: number) => t(key).padEnd(Math.max(width, t(key).length + 1));
  const originIndent = kind === 'typedData' ? '' : '  ';
  const facts = {
    names: labelledValues(rows, originIndent + pad('confirm.name', 9)),
    urls: labelledValues(rows, originIndent + pad('confirm.url', 9)),
    channels: labelledValues(rows, `  ${t('confirm.channel')} `),
  };
  if (kind === 'typedData')
    return {
      ...facts,
      fields: rows.filter((line) => line.startsWith('message.')).map(sourcePreview),
      signing: labelledValues(rows, pad('confirm.signing', 11)),
      primary: labelledValues(rows, `${t('confirm.primaryType')} `),
      domain: ['name', 'version', 'chainId', 'verifyingContract', 'salt'].map((field) =>
        labelledValues(rows, `${translate(language, 'confirm.domain', { field })} `).map((value) =>
          value === t('confirm.absent') ? '(not provided)' : value,
        ),
      ),
    };
  if (kind === 'message')
    return {
      ...facts,
      body: summary.pages
        .flatMap((page) =>
          page
            .split('\n')
            .filter((line) => line.startsWith('\u200e| '))
            .map((line) => line.slice(3)),
        )
        .join('')
        .replace(t('confirm.empty'), '(empty message)'),
    };
  return {
    ...facts,
    to: labelledValues(rows, pad('confirm.to', 11)),
    from: labelledValues(rows, pad('confirm.from', 11)),
    data: labelledValues(rows, pad('confirm.data', 11)).map((value) =>
      value === t('confirm.none') ? '(none)' : value,
    ),
    numbers: (
      [
        'confirm.amount',
        'confirm.nonce',
        'confirm.gas',
        'confirm.fee',
        'confirm.cost',
        'confirm.chain',
      ] as const
    ).map((key) =>
      labelledValues(rows, pad(key, 11)).map((value) => value.match(/[0-9]+(?:\.[0-9]+)?/gu)),
    ),
  };
}

for (const language of LANGUAGES) {
  for (const kind of ['typedData', 'message', 'transaction'] as const) {
    test(`${language}: all English-accepted ${kind} fixtures show identical dApp characters`, () => {
      for (const [index, fixture] of cases.entries()) {
        const expected = oracle.cases[index]?.summary;
        if (fixture.request.kind !== kind || !expected) continue;
        const actual = summariseSignatureRequest(fixture.request, fixture.context, language);
        assert.deepEqual(
          shownFacts(actual, language, kind),
          shownFacts(expected, 'en', kind),
          fixture.name,
        );
      }
    });
  }
}

test('the sentinel preview shows precisely the original 44 A characters in every language', () => {
  const fixture = cases.find(({ name }) => name === 'typed preview sentinel');
  assert.ok(fixture);
  for (const language of LANGUAGES) {
    const fields: string[] = logicalRows(
      summariseSignatureRequest(fixture.request, fixture.context, language),
    ).filter((line) => line.startsWith('message.value'));
    assert.deepEqual(fields.map(sourcePreview), [`message.value (string): "${'A'.repeat(44)}…"`]);
  }
});

test('localized budget overflow falls back to exactly the English body-row page boundaries', () => {
  let fallbacks = 0;
  for (const language of LANGUAGES) {
    if (language === 'en') continue;
    for (const [index, fixture] of cases.entries()) {
      const expected = oracle.cases[index]?.summary;
      if (fixture.request.kind === 'transaction' || !expected) continue;
      const actual = summariseSignatureRequest(fixture.request, fixture.context, language);
      if (
        !actual.pages.some(
          (page) =>
            wrapDetailText(`${page}\n\n${translate(language, 'confirm.approvalNote')}`).split('\n')
              .length > 30,
        )
      )
        continue;
      fallbacks++;
      const bodies = (summary: ConfirmSummary) =>
        summary.pages.map((page) =>
          fixture.request.kind === 'message'
            ? page.split('\n').filter((line) => line.startsWith('\u200e| '))
            : unfoldDetail(page)
                .split('\n')
                .filter((line) => line.startsWith('message.'))
                .map(sourcePreview),
        );
      assert.deepEqual(bodies(actual), bodies(expected), `${language}: ${fixture.name}`);
    }
  }
  assert.ok(fallbacks > 0, 'the corpus must exercise the compatibility fallback');
});

register(new URL('./electronMockLoader.mjs', import.meta.url));
const { BrowserWindow, dialog } = await import('electron');
const { confirmSignature } = await import('../src/main/confirm');

test('every English native confirmation page matches origin/dev byte for byte', async (t) => {
  await mockConfirmationClock(t);
  const shown: MessageBoxOptions[] = [];
  t.mock.method(dialog, 'showMessageBox', (_owner: unknown, options?: MessageBoxOptions) => {
    assert.ok(options);
    const { signal, ...display } = options;
    assert.ok(signal instanceof AbortSignal);
    shown.push(display);
    return Promise.resolve({
      response: options.buttons?.includes('Approve & sign') ? 1 : 0,
      checkboxChecked: false,
    });
  });
  const parent = new BrowserWindow();
  let requestNumber = 0;
  for (const [index, fixture] of cases.entries()) {
    const expected = oracle.cases[index];
    assert.ok(expected);
    shown.length = 0;
    if (expected.error !== undefined) {
      await assert.rejects(confirmSignature(parent, fixture.request, fixture.context), {
        message: expected.error,
      });
      assert.equal(shown.length, 0);
      continue;
    }
    assert.ok(expected.summary);
    assert.ok(expected.details);
    assert.equal(
      await finishConfirmation(t, confirmSignature(parent, fixture.request, fixture.context)),
      true,
    );
    requestNumber++;
    const pages = expected.details.length;
    const summary = expected.summary;
    assert.deepEqual(
      shown,
      expected.details.map((detail, page) => {
        const last = page === pages - 1;
        const indicator =
          pages === 1
            ? `Request ${requestNumber}`
            : `Request ${requestNumber}, page ${page + 1} of ${pages}`;
        return {
          type: 'warning',
          buttons: last ? ['Cancel', 'Approve & sign'] : ['Next', 'Cancel'],
          defaultId: last ? 0 : 1,
          cancelId: last ? 0 : 1,
          title: summary.title,
          message: `${indicator}\n${summary.message}`,
          detail,
          noLink: true,
        };
      }),
      fixture.name,
    );
  }
});
