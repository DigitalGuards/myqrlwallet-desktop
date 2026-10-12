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
import {
  DIALOG_CHROME_MESSAGE,
  messageRequest,
  QUANTASWAP_MESSAGE,
  QUANTASWAP_ORDER,
} from './messageReviewFixtures';
import { SIGNER } from './typedDataFixtures';
import { REVIEW_ORIGIN } from './typedDataReviewFixtures';

function messageRows(pages: string[]): string[] {
  return pages.flatMap((page) => {
    const lines = page.split('\n');
    const heading = lines.findIndex((line) => /^Message \((?:text|hex), \d+ bytes\):$/.test(line));
    assert.ok(heading >= 0, 'every page labels its message representation and byte count');
    assert.ok(lines.length > heading + 1, 'every page has an explicit message body');
    return lines.slice(heading + 1);
  });
}

function messageContents(pages: string[]): string[] {
  return messageRows(pages).map((line) => {
    assert.ok(line.startsWith('| '), 'every body row starts with the fixed gutter');
    return line.slice(2);
  });
}

function unescapeTextRow(row: string): string {
  // Convert supplementary escapes while preserving literal escaped backslashes.
  const json = row.replace(
    /\\(?:u\{([0-9a-f]+)\}|.)/gu,
    (escape: string, point: string | undefined) =>
      point === undefined
        ? escape
        : JSON.stringify(String.fromCodePoint(Number.parseInt(point, 16))).slice(1, -1),
  );
  const value: unknown = JSON.parse(`"${json}"`);
  assert.ok(typeof value === 'string');
  return value;
}

function assertTextFidelity(pages: string[], message: string): void {
  const contents = messageContents(pages);
  if (message.length === 0) {
    assert.deepEqual(contents, ['(empty message)']);
    return;
  }
  // Decode each row independently so a split escape also fails reconstruction.
  const restored = Buffer.from(contents.map(unescapeTextRow).join(''), 'utf8');
  assert.deepEqual(restored, Buffer.from(message, 'utf8'));
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
    assert.ok(line.startsWith('| '), 'body rows stay visibly separate from dialog chrome');
    assert.ok(line.trim().length > 0, 'body rows are never visually blank');
    for (const label of [
      'Account:',
      'Page ',
      'Message (',
      'Requested by',
      SIGNATURE_APPROVAL_NOTE,
    ]) {
      assert.equal(line.startsWith(label), false, `body row cannot impersonate ${label}`);
    }
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
  const displayed = messageContents(pages).join('');
  assertTextFidelity(pages, QUANTASWAP_MESSAGE);
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

for (const message of ['', 'Hello, wallet', '  preserve  spaces  ', '(empty message)', '| hello']) {
  test(`short ASCII message ${JSON.stringify(message)} stays on one page`, () => {
    const { pages } = summariseSignatureRequest(messageRequest(message));
    assertBudget(pages);
    assert.equal(pages.length, 1);
    assertTextFidelity(pages, message);
    assert.deepEqual(messageRows(pages), [`| ${message || '(empty message)'}`]);
    assert.ok(pages[0]?.includes(`Message (text, ${message.length} bytes):`));
    assert.ok(pages[0]?.includes('Requested by: wallet renderer (dApp origin not provided)'));
  });
}

test('the 704-byte forged dialog chrome and hostile tail remain inside the message gutter', () => {
  assert.equal(Buffer.byteLength(DIALOG_CHROME_MESSAGE), 704);
  const { pages } = summariseSignatureRequest(messageRequest(DIALOG_CHROME_MESSAGE));
  assert.equal(pages.length, 1);
  assertBudget(pages);
  assertTextFidelity(pages, DIALOG_CHROME_MESSAGE);
  const displayed = messageContents(pages).join('');
  for (const part of [
    'sell 1 Quanta at market; expiry 5m',
    SIGNATURE_APPROVAL_NOTE,
    `Account:   ${groupQrlAddress(SIGNER)}`,
    'Page 1 of 1',
    'Message (text, 61 bytes):',
    'sell 100000 Quanta at market; expiry 1y',
  ]) {
    assert.equal(displayed.split(part).length - 1, 1, part);
  }
});

test('header labels aligned to the new content width retain the gutter', () => {
  for (const label of ['Account:', 'Page ', 'Message (', 'Requested by', SIGNATURE_APPROVAL_NOTE]) {
    const message = ' '.repeat(62) + label;
    const { pages } = summariseSignatureRequest(messageRequest(message));
    assertBudget(pages);
    assertTextFidelity(pages, message);
    assert.equal(messageRows(pages)[1], `| ${label.slice(0, 62)}`);
    assert.equal(messageContents(pages).slice(1).join(''), label);
  }
});

test('space-only rows keep a visible gutter for every Unicode space separator', () => {
  for (const point of [
    0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008,
    0x2009, 0x200a, 0x202f, 0x205f, 0x3000,
  ]) {
    const message = String.fromCodePoint(point).repeat(150);
    const { pages } = summariseSignatureRequest(messageRequest(message));
    assertBudget(pages);
    assertTextFidelity(pages, message);
    assert.ok(messageRows(pages).length > 1);
  }
});

test('ASCII text wraps at 62 content columns including an exact final row', () => {
  for (const length of [61, 62, 63, 124, 125]) {
    const message = 'a'.repeat(length);
    const { pages } = summariseSignatureRequest(messageRequest(message));
    assertBudget(pages);
    assertTextFidelity(pages, message);
    const rows = messageContents(pages);
    assert.equal(rows.length, Math.ceil(length / 62));
    assert.ok(rows.slice(0, -1).every((line) => line.length === 62));
    assert.equal(rows.at(-1)?.length, length % 62 || 62);
  }
});

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
    const rows = messageContents(pages);
    assert.equal(rows.join(''), hex);
    assert.deepEqual(Buffer.from(rows.join(''), 'hex'), Buffer.from(bytes));
    assert.ok(rows.slice(0, -1).every((line) => line.length === 62));
    assert.equal(rows.at(-1)?.length, 4);
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
    const hex = messageContents(pages).join('');
    assert.equal(hex, bytes.toString('hex'));
    assert.deepEqual(Buffer.from(hex, 'hex'), bytes);
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
  assert.equal(messageContents(pages).join(''), `\\ufeff${message.slice(1)}`);
  assertTextFidelity(pages, message);
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
    const prefix = 'a'.repeat(61);
    const suffix = 'b'.repeat(61);
    const message = prefix + char + suffix;
    const { pages } = summariseSignatureRequest(messageRequest(message));
    assertBudget(pages);
    assertTextFidelity(pages, message);
    const rows = messageContents(pages);
    assert.equal(rows.join(''), prefix + escaped + suffix);
    assert.ok(rows.some((line) => line.startsWith(escaped)));
  });
}

test('literal escape syntax and gutter text round-trip alongside escaped code points', () => {
  const message = '\\u{e0061}\\u0000\\n\\\\| "\u{e0061}\0\n'.repeat(100);
  const { pages } = summariseSignatureRequest(messageRequest(message));
  assertBudget(pages);
  assert.ok(pages.length > 1);
  assertTextFidelity(pages, message);
});

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
