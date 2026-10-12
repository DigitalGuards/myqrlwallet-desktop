import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DETAIL_LINE_COLUMNS,
  displayWidth,
  SIGNATURE_APPROVAL_NOTE,
  TYPED_DATA_DISPLAY_LIMITS,
  summariseSignatureRequest,
  typedDataDisplayLines,
  wrapDetailText,
} from '../src/main/confirmSummary';
import { groupQrlAddress } from '../src/shared/address';
import { SignatureRequestSchema } from '../src/shared/schemas';
import {
  DIALOG_CHROME_MESSAGE,
  GTK_WRAP_MESSAGE,
  messageRequest,
  QUANTASWAP_MESSAGE,
  QUANTASWAP_ORDER,
} from './messageReviewFixtures';
import { SIGNER } from './typedDataFixtures';
import { REVIEW_ORIGIN } from './typedDataReviewFixtures';
import { assertDetailWidth, assertTrustedLineStarts, unfoldDetail } from './confirmLayout';

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
    assert.ok(
      line.startsWith('\u200e| '),
      'every body row starts with the main LTR mark and gutter',
    );
    return line.slice(3);
  });
}

function unescapeTextRow(row: string): string {
  // Convert supplementary escapes while preserving literal escaped backslashes.
  const json = row.replace(
    /\\(?:u\{([0-9a-f]+)\}|.)|"/gu,
    (escape: string, point: string | undefined) =>
      point === undefined
        ? escape === '"'
          ? '\\"'
          : escape
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
  for (const page of pages) {
    const displayed = wrapDetailText(`${page}\n\n${SIGNATURE_APPROVAL_NOTE}`);
    assertDetailWidth(displayed);
    assertTrustedLineStarts(displayed);
    assert.ok(typedDataDisplayLines(displayed) <= TYPED_DATA_DISPLAY_LIMITS.lines, displayed);
    assert.equal(typedDataDisplayLines(displayed), displayed.split('\n').length);
    assert.ok(displayed.length <= 30 * (DETAIL_LINE_COLUMNS + 2));
    assert.doesNotMatch(page, /^Page \d+ of \d+$/m);
    assert.ok(unfoldDetail(page).includes(`Account:   ${groupQrlAddress(SIGNER)}`));
  }
  for (const line of messageRows(pages)) {
    assert.ok(line.startsWith('\u200e| '), 'body rows stay visibly separate from dialog chrome');
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
    assert.ok(line.length <= DETAIL_LINE_COLUMNS + 1);
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
  assert.equal(displayed, QUANTASWAP_MESSAGE.replace('\0', '\\u0000'));
  assert.ok(displayed.includes('"maker":"'));
  assert.equal(displayed.includes('\\"'), false);
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
    assert.deepEqual(messageRows(pages), [`\u200e| ${message || '(empty message)'}`]);
    assert.ok(pages[0]?.includes(`Message (text, ${message.length} bytes):`));
    assert.ok(
      unfoldDetail(pages[0] ?? '').includes(
        'Requested by: wallet renderer (dApp origin not provided)',
      ),
    );
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

test('a 247-byte message keeps the forged page counter inside bounded gutter rows', () => {
  assert.equal(Buffer.byteLength(GTK_WRAP_MESSAGE), 247);
  const { pages } = summariseSignatureRequest(messageRequest(GTK_WRAP_MESSAGE));
  assertBudget(pages);
  assertTextFidelity(pages, GTK_WRAP_MESSAGE);
  assert.ok(messageContents(pages).join('').includes('Page 1 of 1'));
  assert.doesNotMatch(pages.join('\n'), /^Page 1 of 1$/m);
});

test('every invisible character category and control byte round-trips through visible escapes', () => {
  const points = [
    ...Array.from({ length: 32 }, (_, index) => index),
    ...Array.from({ length: 33 }, (_, index) => 0x7f + index),
    0x061c,
    0x200e,
    0xe000,
    0xf0000,
    0x0378,
    0x2028,
    0x2029,
    0x034f,
    0x115f,
    0x1160,
    0x3164,
    0xffa0,
    0x180b,
    0x180e,
    0x180f,
    0x2800,
    0xfff9,
    0xfffa,
    0xfffb,
    0xfe00,
    0xfe0f,
    0xe0100,
    0xe01ef,
    0xe0020,
    0xe0061,
    0xe007f,
  ];
  const message = String.fromCodePoint(...points);
  const { pages } = summariseSignatureRequest(messageRequest(message));
  assertBudget(pages);
  assertTextFidelity(pages, message);
  for (const point of points) {
    assert.equal(messageContents(pages).join('').includes(String.fromCodePoint(point)), false);
  }
});

test('header labels aligned to the new content width retain the gutter', () => {
  for (const label of ['Account:', 'Page ', 'Message (', 'Requested by', SIGNATURE_APPROVAL_NOTE]) {
    const message = ' '.repeat(46) + label;
    const { pages } = summariseSignatureRequest(messageRequest(message));
    assertBudget(pages);
    assertTextFidelity(pages, message);
    assert.ok(messageRows(pages)[1]?.startsWith(`\u200e| ${label.slice(0, 8)}`));
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

test('ASCII text wraps at 46 content columns including an exact final row', () => {
  for (const length of [45, 46, 47, 92, 93]) {
    const message = 'a'.repeat(length);
    const { pages } = summariseSignatureRequest(messageRequest(message));
    assertBudget(pages);
    assertTextFidelity(pages, message);
    const rows = messageContents(pages);
    assert.equal(rows.length, Math.ceil(length / 46));
    assert.ok(rows.slice(0, -1).every((line) => line.length === 46));
    assert.equal(rows.at(-1)?.length, length % 46 || 46);
  }
});

test('wide and hinting-sensitive ASCII uses two columns and wraps at 23 glyphs', () => {
  for (const char of '#%&+<=>@DGHMNOQUW^mw~') {
    assert.equal(displayWidth(char), 2, char);
    for (const length of [22, 23, 24, 46, 47]) {
      const message = char.repeat(length);
      const { pages } = summariseSignatureRequest(messageRequest(message));
      assertBudget(pages);
      assertTextFidelity(pages, message);
      const rows = messageContents(pages);
      assert.equal(rows.length, Math.ceil(length / 23));
      assert.ok(rows.slice(0, -1).every((line) => line.length === 23));
      assert.equal(rows.at(-1)?.length, length % 23 || 23);
    }
  }
  for (const char of 'ABCEFIJKLPRSTVXYZabcdefghijklnopqrstuvxyz0123456789| ') {
    assert.equal(displayWidth(char), 1, char);
  }
  assert.equal(displayWidth('\u200e'), 0);
});

test('wide ASCII spoof padding keeps forged labels within marked rows', () => {
  for (const char of '#%&+<=>@DGHMNOQUW^mw~') {
    for (const [length, label] of [
      [34, ' Page 1 of 1'],
      [30, ' Account: forged'],
    ] as const) {
      const message = char.repeat(length) + label;
      const { pages } = summariseSignatureRequest(messageRequest(message));
      assertBudget(pages);
      assertTextFidelity(pages, message);
      assert.equal(messageContents(pages)[0], char.repeat(23));
      assert.ok(messageContents(pages).join('').endsWith(label));
    }
  }
});

test('non-ASCII advances above 1.27 em use three columns and wrap at 15 glyphs', () => {
  // DejaVuSans.ttf 2.37 cmap/hmtx census, including the two 1.27246 em currency signs.
  const points = [
    0x01c4,
    0x01c5,
    0x01f1,
    0x01f2,
    0x1670,
    0x1671,
    0x1672,
    0x1673,
    0x1674,
    0x1675,
    0x1676,
    0x1685,
    0x168a,
    0x168f,
    0x1694,
    0x2030,
    0x2031,
    0x20a7,
    0x20af,
    0x2152,
    0x2167,
    0x22d8,
    0x22d9,
    0x2326,
    0x2328,
    0x232b,
    0x27f5,
    0x27f6,
    0x27f7,
    0x27f8,
    0x27f9,
    0x27fa,
    0x27fb,
    0x27fc,
    0x27fd,
    0x27fe,
    0x27ff,
    0x2a0c,
    0xa66c,
    0xa698,
    0xa74e,
    0xfb17,
    0xfeb2,
    0xfeb6,
    0x1030c,
    0x1f634,
    ...Array.from({ length: 50 }, (_, index) => 0x1f030 + index),
  ];
  assert.equal(new Set(points).size, 96);
  for (const point of points) {
    const char = String.fromCodePoint(point);
    assert.equal(displayWidth(char), 3, `U+${point.toString(16)}`);
    for (const length of [14, 15, 16, 30, 31]) {
      const message = char.repeat(length);
      const { pages } = summariseSignatureRequest(messageRequest(message));
      assertBudget(pages);
      assertTextFidelity(pages, message);
      const rows = messageContents(pages);
      assert.equal(rows.length, Math.ceil(length / 15));
      assert.ok(rows.slice(0, -1).every((line) => line === char.repeat(15)));
      assert.equal(rows.at(-1), char.repeat(length % 15 || 15));
    }
  }
  for (const point of [
    0x01c3, 0x01c6, 0x01f0, 0x01f3, 0x166f, 0x1677, 0x2032, 0x20a6, 0x20a8, 0x20ae, 0x20b0, 0x2327,
    0x2329, 0x27f4, 0x2800, 0x1030b, 0x1030d, 0x1f02f, 0x1f062, 0x1f633, 0x1f635,
  ]) {
    assert.equal(displayWidth(String.fromCodePoint(point)), 2, `U+${point.toString(16)}`);
  }
});

test('mixed width classes fill the content budget and preserve the next complete code point', () => {
  for (const char of ['\u2031', '\u{1f634}']) {
    const fullRow = `${char.repeat(14)}Oaa`;
    const message = fullRow + char;
    const { pages } = summariseSignatureRequest(messageRequest(message));
    assertBudget(pages);
    assertTextFidelity(pages, message);
    assert.deepEqual(messageContents(pages), [fullRow, char]);
    assert.equal(displayWidth(messageRows(pages)[0] ?? ''), DETAIL_LINE_COLUMNS);
  }
});

test('known ultra-wide glyph ranges use atomic braced escapes and retain all signed bytes', () => {
  const points = [
    0x2e3a,
    0x2e3b,
    0xfdfa,
    0xfdfb,
    0xfdfc,
    0xfdfd,
    ...Array.from({ length: 0x1254f - 0x12000 + 1 }, (_, index) => 0x12000 + index),
  ];
  for (let offset = 0; offset < points.length; offset += 128) {
    const batch = points.slice(offset, offset + 128);
    const message = String.fromCodePoint(...batch);
    const { pages } = summariseSignatureRequest(messageRequest(message));
    assertBudget(pages);
    assertTextFidelity(pages, message);
    assert.equal(
      messageContents(pages).join(''),
      batch.map((point) => `\\u{${point.toString(16)}}`).join(''),
    );
  }
});

test('Hebrew and Arabic body rows start with a main-written LTR mark and gutter', () => {
  for (const word of ['שלום', 'مرحبا']) {
    const message = `${word} Page 1 of 1 \u200e\\u200e `.repeat(60);
    const { pages } = summariseSignatureRequest(messageRequest(message));
    assertBudget(pages);
    assertTextFidelity(pages, message);
    assert.ok(pages.length > 1);
    assert.ok(messageRows(pages).every((line) => line.startsWith('\u200e| ')));
    assert.equal(messageContents(pages).join('').includes('\u200e'), false);
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
    assert.ok(rows.slice(0, -1).every((line) => line.length === 46));
    assert.equal(rows.at(-1)?.length, hex.length % 46);
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
  ['"', '"'],
  ['\\', '\\\\'],
  ['\u202e', '\\u202e'],
  ['\u2066', '\\u2066'],
  ['\u200b', '\\u200b'],
  ['\u200e', '\\u200e'],
  ['\u0085', '\\u0085'],
  ['\u2028', '\\u2028'],
  ['\u2800', '\\u2800'],
  ['\u{e0061}', '\\u{e0061}'],
  ['\u2e3a', '\\u{2e3a}'],
  ['\u2e3b', '\\u{2e3b}'],
  ['\ufdfa', '\\u{fdfa}'],
  ['\ufdfb', '\\u{fdfb}'],
  ['\ufdfc', '\\u{fdfc}'],
  ['\ufdfd', '\\u{fdfd}'],
  ['\u{12000}', '\\u{12000}'],
  ['\u{1254f}', '\\u{1254f}'],
] as const) {
  test(`message escape ${escaped} stays intact at a line boundary`, () => {
    const prefix = 'a'.repeat(46);
    const suffix = 'b'.repeat(46);
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
  const message = '\\u{e0061}\\u0000\\u200e\\u{fdfd}\\n\\\\| "\u{e0061}\u200e\ufdfd\0\n'.repeat(50);
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
