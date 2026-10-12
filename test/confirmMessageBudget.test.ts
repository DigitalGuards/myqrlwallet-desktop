import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SIGNATURE_APPROVAL_NOTE,
  TYPED_DATA_DISPLAY_LIMITS,
  summariseSignatureRequest,
  typedDataDisplayLines,
} from '../src/main/confirmSummary';
import { groupQrlAddress } from '../src/shared/address';
import { SignatureRequestSchema } from '../src/shared/schemas';
import { messageRequest, QUANTASWAP_MESSAGE, QUANTASWAP_ORDER } from './messageReviewFixtures';
import { SIGNER } from './typedDataFixtures';
import { REVIEW_ORIGIN } from './typedDataReviewFixtures';

function messageRows(pages: string[]): string[] {
  return pages.flatMap((page) => {
    const lines = page.split('\n');
    const heading = lines.findIndex((line) => /^Message \((?:text|hex), \d+ bytes\):$/.test(line));
    assert.ok(heading >= 0, 'every page labels its message representation and byte count');
    return lines.slice(heading + 1);
  });
}

function assertBudget(pages: string[]): void {
  assert.ok(pages.length >= 1 && pages.length <= TYPED_DATA_DISPLAY_LIMITS.pages);
  for (const [index, page] of pages.entries()) {
    const displayed = `${page}\n\n${SIGNATURE_APPROVAL_NOTE}`;
    assert.ok(typedDataDisplayLines(displayed) <= TYPED_DATA_DISPLAY_LIMITS.lines, displayed);
    assert.ok(displayed.length <= 30 * 65, 'total character budget includes line breaks');
    assert.ok(page.includes(`Page ${index + 1} of ${pages.length}`));
    assert.ok(page.includes(`Account:   ${groupQrlAddress(SIGNER)}`));
  }
  for (const line of messageRows(pages)) {
    assert.ok(line.length <= TYPED_DATA_DISPLAY_LIMITS.lineChars);
    assert.equal(typedDataDisplayLines(line), 1, 'each message row fits the column budget');
  }
}

test('a QuantaSwap-shaped order shows its complete text exactly once across pages', () => {
  const bytes = Buffer.byteLength(QUANTASWAP_MESSAGE);
  assert.ok(bytes >= 1500 && bytes <= 1700);
  const request = messageRequest(QUANTASWAP_MESSAGE, REVIEW_ORIGIN);
  const before = structuredClone(request);
  const { pages } = summariseSignatureRequest(request);
  assert.deepEqual(request, before);
  assertBudget(pages);
  assert.ok(pages.length > 1);
  const displayed = messageRows(pages).join('');
  assert.equal(displayed, JSON.stringify(QUANTASWAP_MESSAGE).slice(1, -1));
  for (const part of ['QuantaSwap Protocol V2', '\\u0000', ...Object.values(QUANTASWAP_ORDER)]) {
    assert.equal(displayed.split(part).length - 1, 1, part);
  }
  assert.equal(pages.join('').includes('\0'), false);
  for (const page of pages) {
    assert.ok(page.includes(`Message (text, ${bytes} bytes):`));
    assert.ok(page.includes('Requested by dApp (unverified, dApp-supplied):'));
    assert.ok(page.includes(REVIEW_ORIGIN.name));
    assert.ok(page.includes(REVIEW_ORIGIN.url));
    assert.ok(page.includes(REVIEW_ORIGIN.channelId));
  }
});

for (const message of ['', 'Hello, wallet', '  preserve  spaces  ']) {
  test(`short ASCII message ${JSON.stringify(message)} stays on one page`, () => {
    const { pages } = summariseSignatureRequest(messageRequest(message));
    assertBudget(pages);
    assert.equal(pages.length, 1);
    assert.equal(messageRows(pages).join(''), message);
    assert.ok(pages[0]?.includes(`Message (text, ${message.length} bytes):`));
    assert.ok(pages[0]?.includes('Requested by: wallet renderer (dApp origin not provided)'));
  });
}

test('binary messages show every byte once in fixed-width hex lines with either prefix form', () => {
  const bytes = Uint8Array.from({ length: 1025 }, (_, i) => i % 256);
  const hex = Buffer.from(bytes).toString('hex');
  for (const prefix of ['', '0x']) {
    const request = SignatureRequestSchema.parse({
      kind: 'message',
      signer: SIGNER,
      messageHex: prefix + hex,
      origin: REVIEW_ORIGIN,
    });
    const { pages } = summariseSignatureRequest(request);
    assertBudget(pages);
    assert.ok(pages.length > 1);
    assert.ok(pages.every((page) => page.includes('Message (hex, 1025 bytes):')));
    const rows = messageRows(pages);
    assert.equal(rows.join(''), hex);
    assert.ok(rows.slice(0, -1).every((line) => line.length === 64));
    assert.equal(rows.at(-1)?.length, 2);
  }
});

for (const invalid of ['ff', 'c0af', 'eda080', 'e282', 'f4908080']) {
  test(`fatal UTF-8 decoding preserves an invalid ${invalid} tail in hex`, () => {
    const bytes = Buffer.concat([
      Buffer.from('valid prefix '.repeat(50)),
      Buffer.from(invalid, 'hex'),
    ]);
    const { pages } = summariseSignatureRequest(messageRequest(bytes));
    assertBudget(pages);
    assert.ok(pages.every((page) => page.includes(`Message (hex, ${bytes.length} bytes):`)));
    assert.equal(messageRows(pages).join(''), bytes.toString('hex'));
  });
}

test('UTF-8 review preserves a leading BOM, multibyte text and the original byte count', () => {
  const message = `\ufeff${'界🙂éMW'.repeat(200)}`;
  const { pages } = summariseSignatureRequest(messageRequest(message));
  assertBudget(pages);
  assert.ok(pages.length > 1);
  assert.ok(
    pages.every((page) => page.includes(`Message (text, ${Buffer.byteLength(message)} bytes):`)),
  );
  assert.equal(messageRows(pages).join(''), `\\ufeff${message.slice(1)}`);
});

for (const [char, escaped] of [
  ['\0', '\\u0000'],
  ['\n', '\\n'],
  ['\r', '\\r'],
  ['\t', '\\t'],
  ['"', '\\"'],
  ['\\', '\\\\'],
  ['\u202e', '\\u202e'],
  ['\u2066', '\\u2066'],
  ['\u200b', '\\u200b'],
  ['\u0085', '\\u0085'],
  ['\u2028', '\\u2028'],
  ['\u2800', '\\u2800'],
  ['\u{e0061}', '\\u{e0061}'],
] as const) {
  test(`message escape ${escaped} stays intact at a line boundary`, () => {
    const prefix = 'a'.repeat(63);
    const suffix = 'b'.repeat(63);
    const { pages } = summariseSignatureRequest(messageRequest(prefix + char + suffix));
    assertBudget(pages);
    const rows = messageRows(pages);
    assert.equal(rows.join(''), prefix + escaped + suffix);
    assert.ok(rows.some((line) => line.startsWith(escaped)));
  });
}

test('escaped origin metadata counts toward the message review budget', () => {
  const request = messageRequest('hello', {
    ...REVIEW_ORIGIN,
    url: `https://dapp.example/${'\u200b'.repeat(230)}`,
  });
  assert.throws(
    () => summariseSignatureRequest(request),
    /message too long to review in the trusted dialog/,
  );
});
