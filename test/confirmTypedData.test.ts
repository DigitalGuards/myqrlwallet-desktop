import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summariseSignatureRequest, TYPED_DATA_DISPLAY_LIMITS } from '../src/main/confirmSummary';
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
  assert.doesNotMatch(detail, /WARNING/);
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
  assert.ok(detail.includes(`message.recipients[2] (address): ${groupQrlAddress(recipients[2])}`));
  assert.match(detail, /message.deltas\[0\] \(int256\): -1/);
  assert.match(
    detail,
    /message.deltas\[1\] \(int256\): -57896044618658097711785492504343953926634992332820282019728792003956564819968/,
  );
  assert.match(
    detail,
    /message.cap \(uint256\): 115792089237316195423570985008687907853269984665640564039457584007913129639935/,
  );
  assert.match(detail, /message.flag \(bool\): true/);
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
  assert.match(summary.detail, /Connected chainId: 1/);
  assert.match(summary.detail, /WARNING: domain chainId differs from the connected chain/);
  assert.match(summary.detail, /Domain chainId: 3151909/);
  assert.deepEqual(request, before);
  const noChain = summariseSignatureRequest(typedRequest(payloadWith()));
  assert.match(noChain.detail, /Domain chainId: \(not provided\)/);
  assert.match(noChain.detail, /QRL-SIGN-TYPED-v1/);
  assert.doesNotMatch(noChain.detail, /WARNING/);
});

test('summary caps fields precisely and names every omitted signed leaf', () => {
  const values = Array.from({ length: TYPED_DATA_DISPLAY_LIMITS.fields + 7 }, (_, i) => i);
  const { detail } = summariseSignatureRequest(typedRequest(payloadWith('uint8[]', values)));
  assert.match(detail, /Message fields \(up to 20 shown\)/);
  assert.match(detail, /message.value\[19\] \(uint8\): 19/);
  assert.doesNotMatch(detail, /message.value\[20\]/);
  assert.match(
    detail,
    /and 7 more fields\nWARNING: additional fields are included in this signature/,
  );
  const empty = summariseSignatureRequest(typedRequest(payloadWith('address[]', []))).detail;
  assert.match(empty, /message.value \(address\[\]\): \[\]/);
  assert.match(empty, /QRL-SIGN-TYPED-v2/);
});

test('long text is explicitly truncated; control characters cannot forge rows', () => {
  const payload = payloadWith('string', 'a'.repeat(400));
  payload.domain['name'] = 'dApp\nWARNING: forged\u202e\u0085\u2014';
  const { detail } = summariseSignatureRequest(typedRequest(payload));
  assert.ok(detail.includes('Domain name: "dApp\\nWARNING: forged\\u202e\\u0085\\u2014"'));
  assert.match(detail, /\[truncated; 400 characters total\]/);
  assert.doesNotMatch(detail, /\nWARNING: forged/);
  assert.doesNotMatch(detail, /[\u202e\u0085\u2014]/);
  const quoted = summariseSignatureRequest(
    typedRequest(payloadWith('string', '"\nScheme: v1')),
  ).detail;
  assert.ok(quoted.includes('message.value (string): "\\"\\nScheme: v1"'));
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
