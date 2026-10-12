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
import { type TypedDataPayload } from '../src/shared/typedData';
import { payloadWith, SIGNER, typedRequest } from './typedDataFixtures';

const ORIGIN = {
  via: 'dapp',
  name: 'QRL Connect Test dApp',
  url: 'https://dapp.example/',
  channelId: '12345678-abcd-1234-abcd-123456789012',
} as const;
const CONTRACT = `Q${'b'.repeat(128)}`;

function withDomain(payload: TypedDataPayload): TypedDataPayload {
  return {
    ...payload,
    types: {
      ...payload.types,
      QRLDomain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
    },
    domain: { name: 'Batch payout', version: '1', chainId: 3151909, verifyingContract: CONTRACT },
  };
}

function summaryWithOrigin(payload: TypedDataPayload, connectedChainId = 3151909): string {
  const request = SignatureRequestSchema.parse({
    kind: 'typedData',
    payload,
    signer: SIGNER,
    origin: ORIGIN,
  });
  const before = structuredClone(request);
  const summary = summariseSignatureRequest(request, { connectedChainId });
  assert.deepEqual(request, before);
  assert.deepEqual(summariseSignatureRequest(request, { connectedChainId }), summary);
  return summary.detail;
}

function assertBudget(detail: string): void {
  const displayed = `${detail}\n\n${SIGNATURE_APPROVAL_NOTE}`;
  assert.ok(typedDataDisplayLines(displayed) <= 30, displayed);
  assert.ok(displayed.length <= 30 * 65, 'total character budget includes line breaks');
}

function assertOmissions(detail: string, total: number): string[] {
  const rows = detail.split('\n').filter((line) => line.startsWith('message.'));
  assert.ok(rows.length < total);
  const notice = `and ${total - rows.length} more fields\nWARNING: additional fields are included in this signature.`;
  assert.ok(detail.includes(notice), detail);
  assert.ok(detail.indexOf(notice) > detail.indexOf('Primary type:'));
  assert.ok(detail.indexOf(notice) < detail.indexOf('Message fields'));
  return rows;
}

function assertSecurityDetails(detail: string): void {
  const header = detail.slice(0, detail.indexOf('Message fields'));
  for (const value of [
    'Requested by dApp (unverified, dApp-supplied):',
    ORIGIN.name,
    ORIGIN.url,
    ORIGIN.channelId,
    `Account:   ${groupQrlAddress(SIGNER)}`,
    'Scheme:    QRL-SIGN-TYPED-v2',
    'Domain name: "Batch payout"',
    'Domain version: "1"',
    'Domain chainId: 3151909',
    `Domain verifyingContract: ${groupQrlAddress(CONTRACT)}`,
    'Wallet network chainId:',
    'Primary type:',
  ]) {
    assert.ok(header.includes(value), value);
  }
}

test('25 long string fields fit with the full security header, footer and exact omission count', () => {
  const fields = Array.from({ length: 25 }, (_, index) => ({
    name: `note${index}`,
    type: 'string',
  }));
  const payload = withDomain({
    types: { QRLDomain: [{ name: 'name', type: 'string' }], Notes: fields },
    primaryType: 'Notes',
    domain: { name: 'Notes' },
    message: Object.fromEntries(fields.map(({ name }) => [name, 'a'.repeat(1000)])),
  });
  const detail = summaryWithOrigin(payload);
  assertBudget(detail);
  assertSecurityDetails(detail);
  const rows = assertOmissions(detail, 25);
  assert.ok(rows.length > 0);
  for (const [index, row] of rows.entries()) {
    assert.ok(row.startsWith(`message.note${index} (string): "aaaa`));
    assert.match(row, /…" \[1000 characters\]$/);
  }
});

test('12 address recipients fit by omitting whole fields and preserving every displayed address', () => {
  const recipients = Array.from(
    { length: 12 },
    (_, index) => `Q${(index + 1).toString(16).padStart(128, '0')}`,
  );
  const payload = withDomain(payloadWith('address[]', recipients));
  for (const connectedChainId of [3151909, 1]) {
    const detail = summaryWithOrigin(payload, connectedChainId);
    assertBudget(detail);
    assertSecurityDetails(detail);
    const rows = assertOmissions(detail, recipients.length);
    assert.ok(rows.length > 0);
    for (const [index, row] of rows.entries()) {
      const recipient = recipients[index];
      assert.ok(recipient);
      assert.equal(row, `message.value[${index}] (address): ${groupQrlAddress(recipient)}`);
      assert.doesNotMatch(row, /…|truncated/);
    }
    if (connectedChainId === 1) {
      const warning = 'WARNING: domain chainId differs from the wallet network.';
      assert.ok(detail.includes(warning));
      assert.ok(detail.indexOf(warning) < detail.indexOf('Message fields'));
    }
  }
});

test('long bytes, wide text and escaped controls share the same total display budget', () => {
  for (const [type, value, ending] of [
    ['bytes', `0x${'ab'.repeat(1000)}`, '…" [1000 bytes]'],
    ['string', 'W'.repeat(1000), '…" [1000 characters]'],
    ['string', '界'.repeat(1000), '…" [1000 characters]'],
    ['string', '\u202e'.repeat(1000), '…" [1000 characters]'],
  ] as const) {
    const detail = summaryWithOrigin(
      payloadWith(
        `${type}[]`,
        Array.from({ length: 25 }, () => value),
      ),
    );
    assertBudget(detail);
    const rows = assertOmissions(detail, 25);
    assert.ok(rows.length > 0);
    assert.ok(rows.every((row) => row.endsWith(ending)));
    assert.doesNotMatch(detail, /\u202e/);
    assert.match(
      detail,
      /WARNING: this signature is not bound to a chain and can be replayed on other chains\./,
    );
  }
});

test('long field paths consume wrapped space, with omissions counted through nested arrays', () => {
  const name = 'long_field_name_'.repeat(4);
  const payload = payloadWith(
    'uint8[][]',
    Array.from({ length: 4 }, () => Array.from({ length: 25 }, () => 1)),
  );
  payload.types['Payload'] = [{ name, type: 'uint8[][]' }];
  payload.message = { [name]: payload.message['value'] };
  const detail = summaryWithOrigin(payload);
  assertBudget(detail);
  const rows = assertOmissions(detail, 100);
  assert.ok(rows.length > 0 && rows.length < 5);
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
  const { detail } = summariseSignatureRequest(typedRequest(payload));
  assertBudget(detail);
  assert.ok(detail.includes(`Domain name: "${name}"`));
  assert.ok(detail.includes(`Domain version: "${version}"`));
  assert.ok(detail.includes(`Domain salt: "${salt}"`));
  assert.doesNotMatch(detail, /…|truncated/);
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

test('even a zero-row display names all omitted fields and keeps the warning', () => {
  const payload = withDomain(payloadWith('address[]', [CONTRACT, SIGNER]));
  payload.domain['name'] = 'n'.repeat(150);
  const detail = summaryWithOrigin(payload, 1);
  assertBudget(detail);
  assert.deepEqual(assertOmissions(detail, 2), []);
  assert.ok(detail.includes(`Domain name: "${'n'.repeat(150)}"`));
});

test('small payload text stays unchanged', () => {
  const { detail } = summariseSignatureRequest(typedRequest(payloadWith('string', 'hello')));
  assert.equal(
    detail,
    [
      'Requested by: wallet renderer (dApp origin not provided)',
      '',
      `Account:   ${groupQrlAddress(SIGNER)}`,
      'Scheme:    QRL-SIGN-TYPED-v1',
      'Domain name: "Test dApp"',
      'Domain version: (not provided)',
      'Domain chainId: (not provided)',
      'Domain verifyingContract: (not provided)',
      'Domain salt: (not provided)',
      'WARNING: this signature is not bound to a chain and can be replayed on other chains.',
      'Primary type: Payload',
      'Message fields (up to 20 shown):',
      'message.value (string): "hello"',
    ].join('\n'),
  );
  assertBudget(detail);
});

test('line accounting includes blanks, word boundaries, long tokens and wide characters', () => {
  assert.deepEqual(TYPED_DATA_DISPLAY_LIMITS, {
    lines: 30,
    lineChars: 64,
    fields: 20,
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
