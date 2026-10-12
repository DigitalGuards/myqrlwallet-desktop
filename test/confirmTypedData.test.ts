import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  originDetail,
  summariseSignatureRequest,
  TYPED_DATA_DISPLAY_LIMITS,
} from '../src/main/confirmSummary';
import { groupQrlAddress } from '../src/shared/address';
import { SignatureRequestSchema } from '../src/shared/schemas';
import { isRecord, isArray } from '../src/shared/guards';
import { canonical, payloadWith, typedRequest, SIGNER } from './typedDataFixtures';

test('typed-data summary shows origin, scheme, domain, primary type and grouped addresses', () => {
  const vector = canonical.schemeVectors[0];
  assert.ok(vector);
  const req = {
    ...typedRequest(vector.payload),
    origin: {
      via: 'dapp' as const,
      name: 'Test dApp',
      url: 'https://dapp.example',
      channelId: 'abcdef01',
    },
  };
  const { title, detail } = summariseSignatureRequest(req, { connectedChainId: 3151909 });
  assert.equal(title, 'Confirm typed-data signature');
  assert.match(detail, /Requested by dApp \(unverified, dApp-supplied\):/);
  assert.match(detail, /https:\/\/dapp.example/);
  assert.ok(detail.indexOf('Requested by') < detail.indexOf('Scheme:'));
  assert.match(detail, /Scheme: +QRL-SIGN-TYPED-v2/);
  assert.match(detail, /Domain name: "QuantaPool"/);
  assert.match(detail, /Domain version: "1"/);
  assert.match(detail, /Domain chainId: 3151909/);
  const contract = vector.payload.domain['verifyingContract'];
  const staker = vector.payload.message['staker'];
  assert.equal(typeof contract, 'string');
  assert.equal(typeof staker, 'string');
  if (typeof contract !== 'string' || typeof staker !== 'string')
    throw new Error('invalid fixture');
  assert.ok(detail.includes(`Domain verifyingContract: ${groupQrlAddress(contract)}`));
  assert.ok(detail.includes(`message.staker (address): ${groupQrlAddress(staker)}`));
  assert.ok(detail.includes(groupQrlAddress(SIGNER)));
  assert.match(detail, /Primary type: StakeIntent/);
  assert.match(detail, /message.qrlAmount \(uint256\): 1000000000000000000000/);
  assert.doesNotMatch(detail, /WARNING: domain chainId/);
  assert.match(detail, /and 3 more fields\nWARNING: additional fields/);
});

test('nested structs, arrays, integer minima, maxima, bools and salt have readable rows', () => {
  const vector = canonical.schemeVectors[1];
  assert.ok(vector);
  const { detail } = summariseSignatureRequest(typedRequest(vector.payload));
  const payer = vector.payload.message['payer'];
  const recipients = vector.payload.message['recipients'];
  assert.ok(isRecord(payer) && typeof payer['addr'] === 'string');
  assert.ok(isArray(recipients) && typeof recipients[2] === 'string');
  assert.ok(detail.includes(`message.payer.addr (address): ${groupQrlAddress(payer['addr'])}`));
  assert.match(detail, /message.payer.memo \(string\): "payer note"/);
  const addressDetail = summariseSignatureRequest(
    typedRequest(payloadWith('address[]', recipients)),
  ).detail;
  assert.ok(
    addressDetail.includes(`message.value[2] (address): ${groupQrlAddress(recipients[2])}`),
  );
  const deltas = summariseSignatureRequest(
    typedRequest(payloadWith('int256[2]', vector.payload.message['deltas'])),
  ).detail;
  assert.match(deltas, /message.value\[0\] \(int256\): -1/);
  assert.match(
    deltas,
    /message.value\[1\] \(int256\): -57896044618658097711785492504343953926634992332820282019728792003956564819968/,
  );
  assert.match(
    summariseSignatureRequest(typedRequest(payloadWith('uint256', vector.payload.message['cap'])))
      .detail,
    /message.value \(uint256\): 115792089237316195423570985008687907853269984665640564039457584007913129639935/,
  );
  assert.match(
    summariseSignatureRequest(typedRequest(payloadWith('bool', true))).detail,
    /message.value \(bool\): true/,
  );
  assert.match(detail, /Domain salt: "0x5a/);
});

test('domain chain comparison is numeric, preserves the request and shows mismatches', () => {
  const payload = payloadWith();
  payload.types['QRLDomain'] = [
    { name: 'name', type: 'string' },
    { name: 'chainId', type: 'uint256' },
  ];
  payload.domain['chainId'] = '0x301825';
  const request = typedRequest(payload);
  const before = structuredClone(request);
  assert.doesNotMatch(
    summariseSignatureRequest(request, { connectedChainId: 3151909 }).detail,
    /WARNING/,
  );
  const summary = summariseSignatureRequest(request, { connectedChainId: 1 });
  assert.match(summary.detail, /Wallet network chainId: 1/);
  assert.match(summary.detail, /WARNING: domain chainId differs from the wallet network/);
  assert.match(summary.detail, /Domain chainId: 3151909/);
  assert.deepEqual(request, before);
  const noChain = summariseSignatureRequest(typedRequest(payloadWith()));
  assert.match(noChain.detail, /Domain chainId: \(not provided\)/);
  assert.match(noChain.detail, /QRL-SIGN-TYPED-v1/);
  assert.match(
    noChain.detail,
    /WARNING: this signature is not bound to a chain and can be replayed on other chains\./,
  );
  assert.ok(noChain.detail.indexOf('WARNING:') < noChain.detail.indexOf('Primary type:'));
  const configured = summariseSignatureRequest(typedRequest(payloadWith()), {
    connectedChainId: 3151909,
  });
  assert.match(configured.detail, /Wallet network chainId: 3151909/);
  assert.match(configured.detail, /can be replayed on other chains/);
});

test('summary caps fields precisely and names every omitted signed leaf', () => {
  const values = Array.from({ length: TYPED_DATA_DISPLAY_LIMITS.fields + 7 }, (_, i) => i);
  const { detail } = summariseSignatureRequest(typedRequest(payloadWith('uint8[]', values)));
  assert.match(detail, /Message fields \(up to 20 shown\)/);
  assert.match(detail, /message.value\[10\] \(uint8\): 10/);
  assert.doesNotMatch(detail, /message.value\[11\]/);
  assert.match(
    detail,
    /Primary type: Payload\nand 16 more fields\nWARNING: additional fields are included in this signature\.\nMessage fields/,
  );
  const empty = summariseSignatureRequest(typedRequest(payloadWith('address[]', []))).detail;
  assert.match(empty, /message.value \(address\[\]\): \[\]/);
  assert.match(empty, /QRL-SIGN-TYPED-v2/);
});

test('long text is explicitly truncated; control characters cannot forge rows', () => {
  const payload = payloadWith('string', 'a'.repeat(400));
  payload.domain['name'] = 'dApp\nWARNING: forged\u202e\u0085\u2014';
  const { detail } = summariseSignatureRequest(typedRequest(payload));
  assert.ok(detail.includes('Domain name: "dApp\\nWARNING: forged\\u202e\\u0085\u2014"'));
  assert.match(detail, /…" \[400 characters\]/);
  assert.doesNotMatch(detail, /\nWARNING: forged/);
  assert.doesNotMatch(detail, /[\u202e\u0085]/);
  const quoted = summariseSignatureRequest(
    typedRequest(payloadWith('string', '"\nScheme: v1')),
  ).detail;
  assert.ok(quoted.includes('message.value (string): "\\"\\nScheme: v1"'));
});

const invisiblePoints = [
  ['Cc', 0x0007],
  ['Cc C1', 0x0085],
  ['Cf', 0x061c],
  ['Co BMP', 0xe000],
  ['Co supplementary', 0xf0000],
  ['Cn', 0x0378],
  ['Zl', 0x2028],
  ['Zp', 0x2029],
  ['combining grapheme joiner', 0x034f],
  ['Hangul choseong filler', 0x115f],
  ['Hangul jungseong filler', 0x1160],
  ['Hangul filler', 0x3164],
  ['halfwidth Hangul filler', 0xffa0],
  ['Mongolian selector 1', 0x180b],
  ['Mongolian selector 2', 0x180c],
  ['Mongolian selector 3', 0x180d],
  ['Mongolian vowel separator', 0x180e],
  ['Mongolian selector 4', 0x180f],
  ['braille blank', 0x2800],
  ['interlinear annotation anchor', 0xfff9],
  ['interlinear annotation separator', 0xfffa],
  ['interlinear annotation terminator', 0xfffb],
  ['variation selector 1', 0xfe00],
  ['variation selector 16', 0xfe0f],
  ['variation selector 17', 0xe0100],
  ['variation selector 256', 0xe01ef],
  ['tag space', 0xe0020],
  ['tag letter', 0xe0061],
  ['cancel tag', 0xe007f],
] as const;

for (const [label, point] of invisiblePoints) {
  test(`typed data and origin escape invisible ${label}`, () => {
    const char = String.fromCodePoint(point);
    const escaped =
      point > 0xffff ? `\\u{${point.toString(16)}}` : `\\u${point.toString(16).padStart(4, '0')}`;
    const text = `before${char}after`;
    const payload = payloadWith('string', text);
    payload.domain['name'] = text;
    const { detail } = summariseSignatureRequest(typedRequest(payload));
    assert.ok(detail.includes(`Domain name: "before${escaped}after"`));
    assert.ok(detail.includes(`message.value (string): "before${escaped}after"`));
    const origin = originDetail({
      via: 'dapp',
      name: text,
      url: `https://dapp.example/${text}`,
      channelId: 'abc',
    });
    assert.ok(origin.includes(`Name:    before${escaped}after`));
    assert.ok(origin.includes(`URL:     https://dapp.example/before${escaped}after`));
    assert.equal(detail.includes(char), false);
    assert.equal(origin.includes(char), false);
  });
}

test('tag-encoded instructions stay escaped and oversized origin display rejects', () => {
  const hidden = Array.from(' and transfer all to attacker', (char) =>
    String.fromCodePoint(0xe0000 + char.charCodeAt(0)),
  ).join('');
  const request = SignatureRequestSchema.parse({
    kind: 'typedData',
    signer: SIGNER,
    payload: payloadWith('string', hidden),
    origin: {
      via: 'dapp',
      name: `dApp${hidden}`,
      url: `https://dapp.example/${hidden}`,
      channelId: 'abc',
    },
  });
  assert.throws(() => summariseSignatureRequest(request), /security details exceed/);
  const { detail } = summariseSignatureRequest(typedRequest(payloadWith('string', hidden)));
  assert.equal(detail.includes(hidden), false);
  const origin = originDetail(request.origin);
  assert.ok(origin.includes('Name:    dApp\\u{e0020}\\u{e0061}'));
  assert.ok(origin.includes('URL:     https://dapp.example/\\u{e0020}'));
  assert.ok(detail.includes('message.value (string): "\\u{e0020}'));
});

test('dApp punctuation remains byte-faithful in domain, message and origin text', () => {
  const text = 'before\u2014after';
  const payload = payloadWith('string', text);
  payload.domain['name'] = text;
  const request = SignatureRequestSchema.parse({
    kind: 'typedData',
    signer: SIGNER,
    payload,
    origin: { via: 'dapp', name: text, url: `https://dapp.example/${text}`, channelId: 'abc' },
  });
  const before = structuredClone(request);
  const { detail } = summariseSignatureRequest(request);
  for (const prefix of [
    'Domain name: "',
    'message.value (string): "',
    'Name:    ',
    'URL:     https://dapp.example/',
  ]) {
    assert.ok(detail.includes(`${prefix}${text}`));
  }
  assert.equal(detail.includes('\\u2014'), false);
  assert.deepEqual(request, before);
});

test('URL whitespace and direction marks cannot forge trusted origin rows', () => {
  const req = SignatureRequestSchema.parse({
    ...typedRequest(payloadWith()),
    origin: {
      via: 'dapp',
      name: 'dApp',
      channelId: 'abc',
      url: 'https://dapp.example/\nScheme: v2\u202e',
    },
  });
  const { detail } = summariseSignatureRequest(req);
  assert.ok(detail.includes('https://dapp.example/\\nScheme: v2\\u202e'));
  assert.doesNotMatch(detail, /\nScheme: v2/);
  assert.doesNotMatch(detail, /\u202e/);
});
