import assert from 'node:assert/strict';
import { test } from 'node:test';
import { originDetail, summariseSignatureRequest } from '../src/main/confirmSummary';
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
  const { title, pages } = summariseSignatureRequest(req, { connectedChainId: 3151909 });
  const detail = pages.join('\n');
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
  assert.doesNotMatch(detail, /more fields|additional fields/);
  assert.match(detail, /message.deadline \(uint64\):/);
});

test('nested structs, arrays, integer minima, maxima, bools and salt have readable rows', () => {
  const vector = canonical.schemeVectors[1];
  assert.ok(vector);
  const { pages } = summariseSignatureRequest(typedRequest(vector.payload));
  const detail = pages.join('\n');
  const payer = vector.payload.message['payer'];
  const recipients = vector.payload.message['recipients'];
  assert.ok(isRecord(payer) && typeof payer['addr'] === 'string');
  assert.ok(isArray(recipients) && typeof recipients[2] === 'string');
  assert.ok(detail.includes(`message.payer.addr (address): ${groupQrlAddress(payer['addr'])}`));
  assert.match(detail, /message.payer.memo \(string\): "payer note"/);
  const addressDetail = summariseSignatureRequest(
    typedRequest(payloadWith('address[]', recipients)),
  ).pages.join('\n');
  assert.ok(
    addressDetail.includes(`message.value[2] (address): ${groupQrlAddress(recipients[2])}`),
  );
  const deltas = summariseSignatureRequest(
    typedRequest(payloadWith('int256[2]', vector.payload.message['deltas'])),
  ).pages.join('\n');
  assert.match(deltas, /message.value\[0\] \(int256\): -1/);
  assert.match(
    deltas,
    /message.value\[1\] \(int256\): -57896044618658097711785492504343953926634992332820282019728792003956564819968/,
  );
  assert.match(
    summariseSignatureRequest(
      typedRequest(payloadWith('uint256', vector.payload.message['cap'])),
    ).pages.join('\n'),
    /message.value \(uint256\): 115792089237316195423570985008687907853269984665640564039457584007913129639935/,
  );
  assert.match(
    summariseSignatureRequest(typedRequest(payloadWith('bool', true))).pages.join('\n'),
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
    summariseSignatureRequest(request, { connectedChainId: 3151909 }).pages.join('\n'),
    /WARNING/,
  );
  const summary = summariseSignatureRequest(request, { connectedChainId: 1 });
  assert.match(summary.pages.join('\n'), /Wallet network chainId: 1/);
  assert.match(summary.pages.join('\n'), /WARNING: domain chainId differs from the wallet network/);
  assert.match(summary.pages.join('\n'), /Domain chainId: 3151909/);
  assert.deepEqual(request, before);
  const noChain = summariseSignatureRequest(typedRequest(payloadWith()));
  assert.match(noChain.pages.join('\n'), /Domain chainId: \(not provided\)/);
  assert.match(noChain.pages.join('\n'), /QRL-SIGN-TYPED-v1/);
  assert.match(
    noChain.pages.join('\n'),
    /WARNING: this signature is not bound to a chain and can be replayed on other chains\./,
  );
  assert.ok(
    noChain.pages.join('\n').indexOf('WARNING:') <
      noChain.pages.join('\n').indexOf('Primary type:'),
  );
  const configured = summariseSignatureRequest(typedRequest(payloadWith()), {
    connectedChainId: 3151909,
  });
  assert.match(configured.pages.join('\n'), /Wallet network chainId: 3151909/);
  assert.match(configured.pages.join('\n'), /can be replayed on other chains/);
});

test('summary paginates all signed leaves and retains empty arrays', () => {
  const values = Array.from({ length: 27 }, (_, i) => i);
  const { pages } = summariseSignatureRequest(typedRequest(payloadWith('uint8[]', values)));
  assert.ok(pages.length > 1);
  const rows = pages.flatMap((page) =>
    page.split('\n').filter((line) => line.startsWith('message.')),
  );
  assert.deepEqual(
    rows,
    values.map((value, i) => `message.value[${i}] (uint8): ${value}`),
  );
  const empty = summariseSignatureRequest(typedRequest(payloadWith('address[]', []))).pages.join(
    '\n',
  );
  assert.match(empty, /message.value \(address\[\]\): \[\]/);
  assert.match(empty, /QRL-SIGN-TYPED-v2/);
});

test('long text is explicitly truncated; control characters cannot forge rows', () => {
  const payload = payloadWith('string', 'a'.repeat(400));
  payload.domain['name'] = 'dApp\nWARNING: forged\u202e\u0085\u2014';
  const { pages } = summariseSignatureRequest(typedRequest(payload));
  const detail = pages.join('\n');
  assert.ok(detail.includes('Domain name: "dApp\\nWARNING: forged\\u202e\\u0085\u2014"'));
  assert.match(detail, /…" \[400 characters\]/);
  assert.doesNotMatch(detail, /\nWARNING: forged/);
  assert.doesNotMatch(detail, /[\u202e\u0085]/);
  const quoted = summariseSignatureRequest(
    typedRequest(payloadWith('string', '"\nScheme: v1')),
  ).pages.join('\n');
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
    const { pages } = summariseSignatureRequest(typedRequest(payload));
    const detail = pages.join('\n');
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
      url: `https://dapp.example/${hidden.repeat(3)}`,
      channelId: 'abc',
    },
  });
  assert.throws(() => summariseSignatureRequest(request), /security details exceed/);
  const { pages } = summariseSignatureRequest(typedRequest(payloadWith('string', hidden)));
  const detail = pages.join('\n');
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
  const { pages } = summariseSignatureRequest(request);
  const detail = pages.join('\n');
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
  const { pages } = summariseSignatureRequest(req);
  const detail = pages.join('\n');
  assert.ok(detail.includes('https://dapp.example/\\nScheme: v2\\u202e'));
  assert.doesNotMatch(detail, /\nScheme: v2/);
  assert.doesNotMatch(detail, /\u202e/);
});
