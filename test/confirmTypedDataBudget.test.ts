import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SIGNATURE_APPROVAL_NOTE,
  TYPED_DATA_DISPLAY_LIMITS,
  summariseSignatureRequest,
  typedDataDisplayLines,
} from '../src/main/confirmSummary';
import { groupQrlAddress } from '../src/shared/address';
import type { TypedDataPayload } from '../src/shared/typedData';
import { payloadWith, SIGNER, typedRequest } from './typedDataFixtures';
import {
  ATTACKER_SPENDER,
  RECIPIENTS,
  REVIEW_CONTRACT,
  REVIEW_ORIGIN,
  UNLIMITED,
  permitPayload,
  reviewCases,
  reviewRequest,
  withReviewDomain,
} from './typedDataReviewFixtures';

function messageRows(pages: string[]): string[] {
  return pages.flatMap((page) => page.split('\n').filter((line) => line.startsWith('message.')));
}

function assertBudget(pages: string[]): void {
  assert.ok(pages.length >= 1 && pages.length <= 10);
  for (const [i, detail] of pages.entries()) {
    const displayed = `${detail}\n\n${SIGNATURE_APPROVAL_NOTE}`;
    assert.ok(typedDataDisplayLines(displayed) <= 30, displayed);
    assert.ok(displayed.length <= 30 * 65, 'total character budget includes line breaks');
    assert.ok(detail.includes(`Page ${i + 1} of ${pages.length}`));
    assert.doesNotMatch(detail, /more fields|additional fields|up to .* shown/);
  }
}

function pagesWithOrigin(payload: TypedDataPayload, connectedChainId = 3151909): string[] {
  const request = reviewRequest(payload);
  const before = structuredClone(request);
  const { pages } = summariseSignatureRequest(request, { connectedChainId });
  assert.deepEqual(request, before);
  assert.deepEqual(summariseSignatureRequest(request, { connectedChainId }).pages, pages);
  assertBudget(pages);
  for (const page of pages) {
    assert.ok(page.startsWith('Requested by dApp (unverified, dApp-supplied):'));
    for (const value of [
      REVIEW_ORIGIN.name,
      REVIEW_ORIGIN.url,
      `Account:   ${groupQrlAddress(SIGNER)}`,
      'Scheme:    QRL-SIGN-TYPED-',
    ]) {
      assert.ok(page.includes(value), value);
      assert.ok(page.indexOf(value) < page.indexOf('Page '));
    }
  }
  return pages;
}

for (const { label, payload, paths } of reviewCases) {
  test(`${label} with origin shows every row exactly once in order within ten pages`, () => {
    const pages = pagesWithOrigin(payload);
    assert.deepEqual(
      messageRows(pages).map((row) => row.split(' (')[0]),
      paths,
    );
    const [first, ...rest] = pages;
    assert.ok(first);
    for (const name of ['name', 'version', 'chainId', 'verifyingContract', 'salt']) {
      assert.ok(first.includes(`Domain ${name}:`));
    }
    assert.ok(first.includes(`Primary type: ${payload.primaryType}`));
    assert.ok(rest.every((page) => !page.includes('Domain name:') && !page.includes('WARNING:')));
  });
}

test('unlimited Permit to an attacker shows the full spender and value', () => {
  const pages = pagesWithOrigin(permitPayload(UNLIMITED));
  assert.ok(pages.length > 1);
  const rows = messageRows(pages);
  assert.equal(rows.length, 5);
  assert.equal(rows[1], `message.spender (address): ${groupQrlAddress(ATTACKER_SPENDER)}`);
  assert.equal(rows[2], `message.value (uint256): ${UNLIMITED}`);
  assert.equal(rows[4], `message.deadline (uint256): ${UNLIMITED}`);
});

test('all 12 addresses remain complete and grouped, with chain warnings on page one', () => {
  const payload = withReviewDomain(payloadWith('address[]', RECIPIENTS));
  for (const connectedChainId of [3151909, 1]) {
    const pages = pagesWithOrigin(payload, connectedChainId);
    assert.deepEqual(
      messageRows(pages),
      RECIPIENTS.map((address, i) => `message.value[${i}] (address): ${groupQrlAddress(address)}`),
    );
    const first = pages[0];
    assert.ok(first);
    assert.ok(first?.includes(`Domain verifyingContract: ${groupQrlAddress(REVIEW_CONTRACT)}`));
    if (connectedChainId === 1) {
      const warning = 'WARNING: domain chainId differs from the wallet network.';
      assert.ok(first.includes(warning));
      assert.ok(first.indexOf(warning) < first.indexOf('Message fields'));
    }
  }
});

test('25 long bytes, wide strings and escaped controls fit with every row present', () => {
  for (const [type, value, ending] of [
    ['bytes', `0x${'ab'.repeat(1000)}`, '…" [1000 bytes]'],
    ['string', 'W'.repeat(1000), '…" [1000 characters]'],
    ['string', '界'.repeat(1000), '…" [1000 characters]'],
    ['string', '\u202e'.repeat(1000), '…" [1000 characters]'],
  ] as const) {
    const pages = pagesWithOrigin(
      payloadWith(
        `${type}[]`,
        Array.from({ length: 25 }, () => value),
      ),
    );
    const rows = messageRows(pages);
    assert.deepEqual(
      rows.map((row) => row.split(' (')[0]),
      Array.from({ length: 25 }, (_, i) => `message.value[${i}]`),
    );
    assert.ok(rows.every((row) => row.endsWith(ending)));
    assert.doesNotMatch(pages.join('\n'), /\u202e/);
    assert.match(
      pages[0] ?? '',
      /WARNING: this signature is not bound to a chain and can be replayed on other chains\./,
    );
  }
});

test('hex values through 66 characters remain complete within the page budget', () => {
  for (const [type, size] of [
    ['bytes1', 1],
    ['bytes30', 30],
    ['bytes31', 31],
    ['bytes32', 32],
    ['bytes', 0],
    ['bytes', 31],
    ['bytes', 32],
  ] as const) {
    const value = `0x${'ab'.repeat(size)}`;
    const pages = pagesWithOrigin(
      payloadWith(
        `${type}[]`,
        Array.from({ length: 25 }, () => value),
      ),
    );
    assert.deepEqual(
      messageRows(pages),
      Array.from({ length: 25 }, (_, i) => `message.value[${i}] (${type}): "${value}"`),
    );
  }
});

test('hex values over 66 characters retain the bounded preview and byte count', () => {
  for (const size of [33, 1000]) {
    const value = `0x${'ab'.repeat(size)}`;
    const pages = pagesWithOrigin(payloadWith('bytes', value));
    const [row] = messageRows(pages);
    assert.ok(row);
    const displayed = row.slice('message.value (bytes): '.length);
    assert.ok(displayed.startsWith('"0xabab'));
    assert.ok(displayed.endsWith(`…" [${size} bytes]`));
    assert.ok(displayed.length <= TYPED_DATA_DISPLAY_LIMITS.valueChars);
  }
});

test('middle-elided paths keep full leaf names and distinguish hidden ancestors', () => {
  const outer = 'outer_'.repeat(10);
  const inner = 'inner_'.repeat(10);
  const longLeaf = 's'.repeat(64);
  const fields = [
    { name: 'owner', type: 'uint8' },
    { name: 'spender', type: 'uint8' },
    { name: longLeaf, type: 'uint8' },
  ];
  const leaf = { owner: 1, spender: 2, [longLeaf]: 3 };
  const pages = pagesWithOrigin({
    types: {
      QRLDomain: [{ name: 'name', type: 'string' }],
      Root: [{ name: outer, type: 'Branch' }],
      Branch: [
        { name: `${inner}a`, type: 'Leaf' },
        { name: `${inner}b`, type: 'Leaf' },
      ],
      Leaf: fields,
    },
    primaryType: 'Root',
    domain: { name: 'Paths' },
    message: { [outer]: { [`${inner}a`]: leaf, [`${inner}b`]: leaf } },
  });
  const rows = messageRows(pages);
  assert.equal(rows.length, 6);
  const labels = rows.map((row) => row.split(' (')[0]);
  assert.equal(new Set(labels).size, 6);
  for (const [i, field] of [...fields, ...fields].entries()) {
    assert.ok(labels[i]?.endsWith(`.${field.name}`));
    assert.ok(labels[i]?.includes(`…#${i + 1}.`));
  }
});

test('full domain text and salt are retained; oversized mandatory metadata rejects', () => {
  const payload = payloadWith();
  const name = 'n'.repeat(250);
  const version = 'version '.repeat(10);
  const salt = `0x${'5a'.repeat(32)}`;
  payload.types['QRLDomain'] = [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'salt', type: 'bytes32' },
  ];
  payload.domain = { name, version, salt };
  const { pages } = summariseSignatureRequest(typedRequest(payload));
  assertBudget(pages);
  const first = pages[0];
  assert.ok(first);
  assert.ok(first?.includes(`Domain name: "${name}"`));
  assert.ok(first.includes(`Domain version: "${version}"`));
  assert.ok(first.includes(`Domain salt: "${salt}"`));
  assert.doesNotMatch(first, /…|truncated/);
  for (const key of ['name', 'version']) {
    const large = structuredClone(payload);
    large.domain[key] = 'x'.repeat(16 * 1024);
    const request = typedRequest(large);
    assert.throws(
      () => summariseSignatureRequest(request),
      /security details exceed the confirmation display limit/,
    );
  }
});

test('large page-one metadata moves complete message rows to subsequent pages', () => {
  const payload = withReviewDomain(payloadWith('address[]', [REVIEW_CONTRACT, SIGNER]));
  payload.domain['name'] = 'n'.repeat(150);
  const pages = pagesWithOrigin(payload, 1);
  assert.ok(pages[0]?.includes(`Domain name: "${'n'.repeat(150)}"`));
  assert.deepEqual(
    messageRows(pages),
    [REVIEW_CONTRACT, SIGNER].map(
      (address, i) => `message.value[${i}] (address): ${groupQrlAddress(address)}`,
    ),
  );
});

test('maximum valid control text escapes bounded prefixes and stops at the page limit', (t) => {
  const value = '\u0007'.repeat(16 * 1024);
  const request = typedRequest(
    payloadWith(
      'string[][]',
      Array.from({ length: 8 }, (_, i) => Array.from({ length: i === 7 ? 244 : 256 }, () => value)),
    ),
  );
  const stringify = t.mock.method(JSON, 'stringify');
  assert.throws(
    () => summariseSignatureRequest(request),
    /too large to review safely on desktop \(maximum 10 pages\)/,
  );
  const sizes = stringify.mock.calls.map((call) => {
    const value: unknown = call.arguments[0];
    return typeof value === 'string' ? value.length : 0;
  });
  assert.ok(sizes.length > 1 && sizes.length < 300);
  assert.ok(Math.max(...sizes) <= TYPED_DATA_DISPLAY_LIMITS.valueChars);
});

test('small payloads fit on a single page with every field', () => {
  const { pages } = summariseSignatureRequest(typedRequest(payloadWith('string', 'hello')));
  assertBudget(pages);
  assert.equal(pages.length, 1);
  assert.match(pages[0] ?? '', /Page 1 of 1/);
  assert.deepEqual(messageRows(pages), ['message.value (string): "hello"']);
});

test('line accounting includes blanks, word boundaries, long tokens and wide characters', () => {
  assert.deepEqual(TYPED_DATA_DISPLAY_LIMITS, {
    lines: 30,
    lineChars: 64,
    pages: 10,
    valueChars: 64,
    labelChars: 80,
  });
  assert.equal(typedDataDisplayLines('a\n\nb'), 3);
  assert.equal(typedDataDisplayLines('a'.repeat(64)), 1);
  assert.equal(typedDataDisplayLines('a'.repeat(65)), 2);
  assert.equal(typedDataDisplayLines(Array.from({ length: 3 }, () => 'a'.repeat(33)).join(' ')), 3);
  assert.equal(typedDataDisplayLines('界'.repeat(33)), 2);
  assert.equal(typedDataDisplayLines('W'.repeat(33)), 2);
});
