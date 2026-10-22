import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  displayWidth,
  paginateTransactionRows,
  SIGNATURE_APPROVAL_NOTE,
  summariseSignatureRequest,
  transactionBodyLineLimit,
  TRANSACTION_DISPLAY,
  typedDataDisplayLines,
  wrapDetailText,
  wrapTransactionHeading,
} from '../src/main/confirmSummary';
import { loadBaseline } from '../scripts/confirmation-baseline.mjs';
import { visibilityCases } from './confirmationVisibilityFixtures';
import { assertDetailWidth, assertTrustedLineStarts } from './confirmLayout';

const baseline = loadBaseline();
const areas = [
  { width: 1024, height: 768 },
  { width: 1280, height: 720 },
];
const continuation = /^\u200e?[^:\n]+: \(continued\)$/;
const sourceLines = (pages: string[]) =>
  pages.flatMap((page) =>
    page.split('\n').filter((line, index) => index !== 0 || !continuation.test(line)),
  );

test('rows that fit a page move intact, including a row exactly as tall as the allowance', () => {
  const rows = ['Amount: 1', 'To: a\n    b\n    c\n    d', 'From: e\n    f', 'Nonce: 2'];
  assert.deepEqual(paginateTransactionRows(rows, 4), [rows[0], rows[1], rows.slice(2).join('\n')]);
  assert.deepEqual(sourceLines(paginateTransactionRows(rows, 4)), rows.join('\n').split('\n'));
});

test('a taller row splits only at existing wrapped lines and repeats its label on each continuation', () => {
  const url = wrapDetailText('  URL:     https://example.org/' + '\\u200b'.repeat(70), 'dapp');
  const lines = url.split('\n');
  assert.ok(lines.length > 8);
  const pages = paginateTransactionRows(['Amount: 1', url, 'Chain id: 1'], 4);
  assert.equal(pages[0], 'Amount: 1');
  assert.equal(pages[1], lines.slice(0, 4).join('\n'));
  assert.equal(pages[2], '\u200e  URL: (continued)\n' + lines.slice(4, 7).join('\n'));
  for (const page of pages.slice(2)) {
    if (page.includes('\u200e    | ')) assert.match(page, /^\u200e {2}URL: \(continued\)\n/);
  }
  for (const page of pages) {
    assert.ok(page.split('\n').length <= 4);
    assertDetailWidth(page);
    assertTrustedLineStarts(page);
  }
  assert.deepEqual(sourceLines(pages), ['Amount: 1', ...lines, 'Chain id: 1']);
});

test('a trusted numeric continuation repeats its label and retains its complete value', () => {
  const amount = wrapDetailText('Amount:    ' + '9'.repeat(300));
  const pages = paginateTransactionRows([amount], 4);
  assert.ok(pages.length > 1);
  assert.ok(pages.slice(1).every((page) => page.startsWith('Amount: (continued)\n')));
  assert.deepEqual(sourceLines(pages), amount.split('\n'));
});

test('heading width boundaries insert only line breaks and preserve both original lines', () => {
  for (const area of areas) {
    const columns = Math.min(46, Math.floor((area.width - 96) / 20));
    const heading = '9'.repeat(columns) + '\nMax cost 0 Quanta.';
    assert.equal(wrapTransactionHeading(heading, area), heading);
    assert.equal(
      wrapTransactionHeading('9'.repeat(columns + 1) + '\nMax cost 0 Quanta.', area),
      '9'.repeat(columns) + '\n9\nMax cost 0 Quanta.',
    );
    const wide = 'M'.repeat(columns);
    const wrapped = wrapTransactionHeading(wide, area);
    assert.equal(wrapped.replaceAll('\n', ''), wide);
    assert.ok(wrapped.split('\n').every((line) => displayWidth(line) <= columns));
  }
});

test('every wrapped heading line and the request label reduce the body allowance on every page', () => {
  const long = visibilityCases.find((fixture) => fixture.name === 'transaction 80 digit heading');
  assert.ok(long);
  const original = baseline.summariseSignatureRequest(long.request, long.context).message;
  for (const area of areas) {
    const summary = summariseSignatureRequest(long.request, long.context, area);
    assert.equal(summary.message.replaceAll('\n', ''), original.replaceAll('\n', ''));
    assert.ok(summary.message.split('\n').length > 2);
    for (const page of summary.pages) {
      const height =
        76 +
        48 +
        (1 + summary.message.split('\n').length) * 29 +
        typedDataDisplayLines(`${page}\n\n${SIGNATURE_APPROVAL_NOTE}`) * 24;
      assert.ok(height <= area.height);
    }
  }
});

test('normal heading allowances are 20 and 18 body lines, including approval-note reservation', () => {
  assert.deepEqual(
    areas.map((area) => transactionBodyLineLimit('Send 1 Quanta?\nMax cost 1 Quanta.', area)),
    [20, 18],
  );
  assert.equal(typedDataDisplayLines('\n' + SIGNATURE_APPROVAL_NOTE), 3);
});

test('one line below, at, and one line above the conservative allowance preserve or paginate exactly', () => {
  const fixture = visibilityCases.find((entry) => entry.name === 'transaction within allowance');
  assert.ok(fixture);
  const original = baseline.summariseSignatureRequest(fixture.request, fixture.context);
  const lines = original.pages.join('\n').split('\n').length;
  const boundary = 76 + 48 + 3 * 29 + (lines + 3) * 24;
  for (const spare of [-1, 0, 1]) {
    const area = { width: 1024, height: boundary + spare * 24 };
    assert.equal(transactionBodyLineLimit(original.message, area), lines + spare);
    const summary = summariseSignatureRequest(fixture.request, fixture.context, area);
    if (spare < 0) assert.ok(summary.pages.length > 1);
    else assert.deepEqual(summary, original);
    assert.deepEqual(sourceLines(summary.pages), original.pages.join('\n').split('\n'));
  }
});

test('the four-body-line floor shows tiny-work-area reviews without rejection or a page cap', () => {
  const fixture = visibilityCases.find((entry) => entry.name === 'transaction invisible URL');
  assert.ok(fixture);
  const area = { width: 1, height: 1 };
  const summary = summariseSignatureRequest(fixture.request, fixture.context, area);
  assert.equal(
    transactionBodyLineLimit(summary.message, area),
    TRANSACTION_DISPLAY.minimumBodyLines,
  );
  assert.ok(summary.pages.length > 10);
  assert.ok(summary.pages.every((page) => page.split('\n').length <= 4));
  assert.deepEqual(
    sourceLines(summary.pages),
    baseline
      .summariseSignatureRequest(fixture.request, fixture.context)
      .pages.join('\n')
      .split('\n'),
  );
});

for (const fixture of visibilityCases) {
  for (const area of areas) {
    test(`${fixture.name} at ${area.width}x${area.height} preserves the release text and row order`, () => {
      let original;
      try {
        original = baseline.summariseSignatureRequest(fixture.request, fixture.context);
      } catch (error) {
        assert.ok(error instanceof Error);
        assert.throws(() => summariseSignatureRequest(fixture.request, fixture.context, area), {
          message: error.message,
        });
        return;
      }
      const summary = summariseSignatureRequest(fixture.request, fixture.context, area);
      if (fixture.request.kind !== 'transaction') {
        assert.deepEqual(summary, original, 'messages and typed data stay byte-identical');
        return;
      }
      assert.deepEqual(sourceLines(summary.pages), original.pages[0]?.split('\n'));
      assert.equal(summary.message.replaceAll('\n', ''), original.message.replaceAll('\n', ''));
      for (const page of summary.pages) {
        assert.ok(page.split('\n').length <= transactionBodyLineLimit(summary.message, area));
        assertDetailWidth(page);
      }
      if (fixture.request.origin) {
        assert.match(summary.pages.at(-1) ?? '', /Only approve if you initiated this action in/);
      }
      if (
        summary.message === original.message &&
        original.pages.join('\n').split('\n').length <=
          transactionBodyLineLimit(summary.message, area)
      ) {
        assert.deepEqual(summary, original, 'within the conservative allowance');
      }
    });
  }
}
