import assert from 'node:assert/strict';
import { visibilityCases } from '../test/confirmationVisibilityFixtures.ts';
import {
  summariseSignatureRequest,
  transactionBodyLineLimit,
  wrapTransactionHeading,
} from '../src/main/confirmSummary.ts';
import { baselineRevision, loadBaseline } from './confirmation-baseline.mjs';

const baseline = loadBaseline();
const areas = [
  { width: 1024, height: 768 },
  { width: 1280, height: 720 },
];
function review(summarise, fixture, area) {
  try {
    return { summary: summarise(fixture.request, fixture.context, area) };
  } catch (error) {
    return { error: error.message };
  }
}

console.log(`Baseline: ${baselineRevision} (1.4.3); after: working tree`);
console.log(
  'Request | Work area | 1.4.3->new pages | Within allowance / identical | Rows/order/text',
);
let largestTransaction = 0;
for (const fixture of visibilityCases) {
  for (const area of areas) {
    const prefix = `${fixture.name} | ${area.width}x${area.height}`;
    const before = review(baseline.summariseSignatureRequest, fixture, area);
    const after = review(summariseSignatureRequest, fixture, area);
    assert.equal(after.error, before.error, `${fixture.name}: acceptance must be identical`);
    if (before.error) {
      console.log(`${prefix} | rejected->rejected | n/a | same rejection`);
      continue;
    }
    const oldRows = before.summary.pages.flatMap((page) => page.split('\n'));
    const newRows = after.summary.pages.flatMap((page, index) => {
      const lines = page.split('\n');
      // Only main-owned colon labels at the beginning of a continuation page
      // may be removed. Every remaining line must equal the release byte for byte.
      if (index > 0 && /^\u200e?[^:\n]+: \(continued\)$/.test(lines[0])) {
        const label = lines.shift().replace(' (continued)', '');
        assert.ok(
          oldRows.some((line) => line.startsWith(label)),
          `${prefix}: repeated label`,
        );
      }
      return lines;
    });
    assert.deepEqual(newRows, oldRows, `${prefix}: concatenated rows, order and text`);
    assert.equal(after.summary.title, before.summary.title);
    let allowance = 'n/a / yes';
    if (fixture.request.kind === 'transaction') {
      const heading = wrapTransactionHeading(before.summary.message, area);
      assert.equal(after.summary.message, heading, `${prefix}: heading breaks only`);
      assert.equal(heading.replaceAll('\n', ''), before.summary.message.replaceAll('\n', ''));
      const limit = transactionBodyLineLimit(heading, area);
      assert.ok(after.summary.pages.every((page) => page.split('\n').length <= limit));
      const within = heading === before.summary.message && oldRows.length <= limit;
      if (within) assert.deepEqual(after.summary, before.summary, `${prefix}: unchanged rendering`);
      allowance = within ? 'yes / yes' : 'no / changed';
      largestTransaction = Math.max(largestTransaction, after.summary.pages.length);
    } else {
      assert.deepEqual(after.summary, before.summary, `${prefix}: unchanged summary`);
    }
    console.log(
      `${prefix} | ${before.summary.pages.length}->${after.summary.pages.length} | ${allowance} | yes/yes/yes`,
    );
  }
}
console.log(`Largest transaction: ${largestTransaction} pages; transaction page cap: none`);
