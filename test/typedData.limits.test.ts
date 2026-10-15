import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { SignatureRequestSchema, TypedDataPayloadSchema } from '../src/shared/schemas';
import { parseSignerRequest } from '../src/shared/protocolGuards';
import {
  TYPED_DATA_LIMITS as LIMITS,
  encodeType,
  parseFieldType,
  type TypedDataPayload,
  type TypeMap,
} from '../src/shared/typedData';
import {
  hasBoundedTypedDataIpcSize,
  TYPED_DATA_MAX_IPC_BYTES,
} from '../src/shared/typedDataIpcSize';
import { computeTypedDataDigest } from '../src/signer/typedData';
import { EXPECTED_CHAIN_ID } from '../src/main/config';
import { payloadWith, SIGNER } from './typedDataFixtures';

function rejects(payload: unknown, reason: RegExp): void {
  const request = { kind: 'typedData', payload, signer: SIGNER };
  const parsed = TypedDataPayloadSchema.safeParse(payload);
  assert.equal<unknown>(parsed.success, false);
  if (!parsed.success) assert.match(parsed.error.issues[0]?.message ?? '', reason);
  assert.equal(SignatureRequestSchema.safeParse(request).success, false);
  assert.equal(
    parseSignerRequest({ type: 'signer:sign', id: 1, request, chainId: EXPECTED_CHAIN_ID }),
    null,
  );
  assert.throws(() => computeTypedDataDigest(payload), { message: reason });
}

function accepts(payload: TypedDataPayload): void {
  assert.equal(TypedDataPayloadSchema.safeParse(payload).success, true);
  assert.equal(computeTypedDataDigest(payload).length, 64);
}

test('strict shape rejects extra display fields and malformed roots', () => {
  for (const bad of [null, [], 'text', 3]) rejects(bad, /invalid typed data/);
  rejects({}, /top-level fields/);
  rejects({ ...payloadWith(), displayName: 'Approve login' }, /top-level fields/);
  rejects(
    { ...payloadWith(), types: { QRLDomain: [{ name: 'name', type: 'string', text: 'x' }] } },
    /struct map/,
  );
  rejects({ ...payloadWith(), domain: [] }, /domain must be an object/);
  rejects({ ...payloadWith(), message: null }, /message must be an object/);
  rejects({ ...payloadWith(), primaryType: 1 }, /primaryType must be a string/);
  rejects({ ...payloadWith(), types: [] }, /struct map/);
  rejects({ ...payloadWith(), types: {} }, /struct types/);
  rejects(
    { ...payloadWith(), types: { ...payloadWith().types, Payload: new Array(1) } },
    /struct map/,
  );
  assert.equal(
    SignatureRequestSchema.safeParse({
      kind: 'typedData',
      payload: payloadWith(),
      signer: SIGNER,
      randomized: false,
    }).success,
    false,
  );
});

test('type count, fields per type and total fields are bounded', () => {
  const types: TypeMap = { ...payloadWith().types };
  for (let i = 0; i < LIMITS.maxTypes; i++) types[`Unused${i}`] = [{ name: 'x', type: 'uint8' }];
  rejects({ ...payloadWith(), types }, /struct map|struct types/);
  const fields = Array.from({ length: LIMITS.maxFieldsPerType + 1 }, (_, i) => ({
    name: `f${i}`,
    type: 'uint8',
  }));
  rejects(
    { ...payloadWith(), types: { ...payloadWith().types, Payload: fields } },
    /struct map|invalid struct/,
  );
  const aggregate = payloadWith();
  for (let i = 0; i < 8; i++) aggregate.types[`Chunk${i}`] = fields.slice(0, 32);
  rejects(aggregate, /too many fields/);
  rejects({ ...payloadWith(), types: { ...payloadWith().types, Payload: [] } }, /invalid struct/);
});

test('identifier and field type lengths, unsafe names and duplicates reject', () => {
  for (const name of ['__proto__', 'constructor', 'prototype', 'bad.name', 'a'.repeat(65)]) {
    const payload = payloadWith();
    payload.types['Payload'] = [{ name, type: 'uint8' }];
    rejects(payload, /invalid field name/);
    rejects(
      {
        ...payloadWith(),
        types: {
          QRLDomain: [{ name: 'name', type: 'string' }],
          [name]: [{ name: 'v', type: 'uint8' }],
        },
        primaryType: name,
      },
      /struct name/,
    );
  }
  rejects({ ...payloadWith(), primaryType: 'X'.repeat(65) }, /invalid primary type/);
  rejects(payloadWith('a'.repeat(LIMITS.maxFieldTypeLength + 1)), /field type too long/);
  rejects(
    {
      ...payloadWith(),
      types: {
        ...payloadWith().types,
        Payload: [
          { name: 'v', type: 'uint8' },
          { name: 'v', type: 'bool' },
        ],
      },
    },
    /duplicate field/,
  );
});

test('million-character field types reject in main within a bounded subprocess', () => {
  const schemaUrl = new URL('../src/shared/schemas.ts', import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      `
    import assert from 'node:assert/strict';
    import { SignatureRequestSchema } from ${JSON.stringify(schemaUrl)};
    const payload = ${JSON.stringify(payloadWith())};
    payload.types.Payload[0].type = '[]'.repeat(500000) + 'x';
    const started = performance.now();
    const result = SignatureRequestSchema.safeParse({ kind: 'typedData', payload, signer: ${JSON.stringify(SIGNER)} });
    assert.equal(result.success, false);
    assert.equal(result.error.issues[0].message, 'field type too long');
    assert.ok(performance.now() - started < 250, 'main validation exceeded 250 ms');
  `,
    ],
    { timeout: 10_000, encoding: 'utf8' },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});

test('all type declarations are capped before traversal and diagnostics bound echoed input', () => {
  const type = '[]'.repeat(500000) + 'x';
  const payload = payloadWith(type);
  assert.throws(() => encodeType('Payload', payload.types), { message: 'field type too long' });
  assert.throws(() => parseFieldType(type, payload.types), { message: 'field type too long' });
  const unused = payloadWith();
  unused.types['Unused'] = [{ name: 'value', type }];
  rejects(unused, /^field type too long$/);
  const domain = payloadWith();
  domain.types['QRLDomain'] = [{ name: 'name', type }];
  rejects(domain, /^field type too long$/);
  const longName = 'a'.repeat(100000) + 'private-tail';
  const parsed = TypedDataPayloadSchema.safeParse({ ...payloadWith(), primaryType: longName });
  assert.equal<unknown>(parsed.success, false);
  if (!parsed.success)
    assert.equal(parsed.error.issues[0]?.message, `invalid primary type: ${'a'.repeat(64)}...`);
  assert.throws(() => parseFieldType('x'.repeat(100) + 'private-tail', {}), {
    message: `unknown type: ${'x'.repeat(64)}...`,
  });
});

test('aggregate IPC cap rejects oversized trees before semantic validation', () => {
  const leaf = '\u0000'.repeat(LIMITS.maxDynamicBytes);
  const count = Math.ceil(TYPED_DATA_MAX_IPC_BYTES / (leaf.length * 6));
  const payload = payloadWith(
    'string[]',
    Array.from({ length: count }, () => leaf),
  );
  const parsed = SignatureRequestSchema.safeParse({ kind: 'typedData', payload, signer: SIGNER });
  assert.equal<unknown>(parsed.success, false);
  if (!parsed.success)
    assert.equal(parsed.error.issues[0]?.message, 'typed data exceeds aggregate IPC size limit');
});

test('aggregate traversal bounds deep, wide and repeatedly shared malformed input', () => {
  const wide = Array.from({ length: 4096 }, () => 0);
  let deep: unknown = 0;
  for (let i = 0; i < 65; i++) deep = [deep];
  let shared: unknown = 0;
  for (let i = 0; i < 32; i++) shared = [shared, shared];
  for (const value of [wide, deep, shared]) {
    const parsed = TypedDataPayloadSchema.safeParse(payloadWith('uint8', value));
    assert.equal<unknown>(parsed.success, false);
    if (!parsed.success)
      assert.equal(parsed.error.issues[0]?.message, 'typed data exceeds aggregate IPC size limit');
  }
});

test('aggregate cap accommodates the full value budget with worst-case JSON escaping and hex expansion', () => {
  const conservativeMaximum =
    LIMITS.maxEncodedValues * (LIMITS.maxDynamicBytes * 6 + LIMITS.maxIdentifierLength + 32) +
    LIMITS.maxTotalFields * (LIMITS.maxIdentifierLength + LIMITS.maxFieldTypeLength + 32) +
    LIMITS.maxTypes * (LIMITS.maxIdentifierLength + 8);
  assert.ok(conservativeMaximum < TYPED_DATA_MAX_IPC_BYTES);
  for (const [type, value] of [
    ['string', '\u0000'.repeat(LIMITS.maxDynamicBytes)],
    ['bytes', `0x${'ab'.repeat(LIMITS.maxDynamicBytes)}`],
  ]) {
    const payload = payloadWith();
    payload.types['Payload'] = Array.from({ length: 8 }, (_, i) => ({
      name: `list${i}`,
      type: `${type}[]`,
    }));
    payload.message = Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [
        `list${i}`,
        Array.from({ length: i === 7 ? 245 : 256 }, () => value),
      ]),
    );
    assert.equal(hasBoundedTypedDataIpcSize(payload), true);
    assert.equal(TypedDataPayloadSchema.safeParse(payload).success, true);
  }
});

test('atomic shadowing, reserved domain, unused and unknown types reject', () => {
  for (const reserved of ['address', 'string', 'bytes', 'bool', 'uint256', 'int8', 'bytes32']) {
    rejects(
      {
        ...payloadWith(),
        types: { ...payloadWith().types, [reserved]: [{ name: 'v', type: 'uint8' }] },
      },
      /reserved by an atomic type/,
    );
  }
  rejects({ ...payloadWith(), primaryType: 'QRLDomain' }, /cannot be the primary/);
  rejects({ ...payloadWith(), primaryType: 'Unknown' }, /unknown primary/);
  const missingDomain = payloadWith();
  delete missingDomain.types['QRLDomain'];
  rejects(missingDomain, /QRLDomain type is required/);
  for (const field of [
    { name: 'chainId', type: 'string' },
    { name: 'surprise', type: 'string' },
  ]) {
    rejects(
      {
        ...payloadWith(),
        types: { ...payloadWith().types, QRLDomain: [{ name: 'name', type: 'string' }, field] },
      },
      /QRLDomain field/,
    );
  }
  rejects(
    {
      ...payloadWith(),
      types: { ...payloadWith().types, QRLDomain: [{ name: 'version', type: 'string' }] },
    },
    /QRLDomain.name/,
  );
  rejects(
    { ...payloadWith(), types: { ...payloadWith().types, Unused: [{ name: 'v', type: 'uint8' }] } },
    /unused referenced type/,
  );
  for (const type of ['Unknown', 'uint', 'uint7', 'int264', 'bytes0', 'bytes33'])
    rejects(payloadWith(type), /unknown type|invalid int width|invalid bytesN width/);
});

function structChain(depth: number): TypedDataPayload {
  const payload = payloadWith();
  delete payload.types['Payload'];
  payload.primaryType = 'Node0';
  let message: Record<string, unknown> = { value: 1 };
  for (let i = depth; i >= 0; i--) {
    payload.types[`Node${i}`] = [{ name: 'value', type: i === depth ? 'uint8' : `Node${i + 1}` }];
    if (i < depth) message = { value: message };
  }
  payload.message = message;
  return payload;
}

test('type graph, value depth, cycles and array nesting are bounded', () => {
  accepts(structChain(11));
  rejects(structChain(LIMITS.maxTypeGraphDepth + 1), /type graph nesting too deep/);
  rejects(structChain(LIMITS.maxTypeGraphDepth), /value nesting too deep/);
  rejects(
    payloadWith(`uint8${'[]'.repeat(LIMITS.maxArrayNesting + 1)}`, []),
    /type nesting too deep/,
  );
  accepts(payloadWith(`uint8${'[]'.repeat(LIMITS.maxArrayNesting)}`, []));
  rejects(payloadWith('Payload', {}), /cyclic type reference/);
  const cycle = payloadWith();
  cycle.message['value'] = cycle.message;
  rejects(cycle, /unsupported uint8 value/);
  const cyclicArray: unknown[] = [];
  cyclicArray.push(cyclicArray);
  rejects(payloadWith('uint8[][]', cyclicArray), /unsupported uint8 value/);
});

test('array size, fixed lengths, malformed elements and total value budget reject', () => {
  for (const type of ['uint8[0]', 'uint8[257]', 'uint8[9007199254740992]'])
    rejects(payloadWith(type, []), /invalid array size/);
  rejects(payloadWith('uint8[2]', [1]), /requires length 2/);
  rejects(
    payloadWith(
      'uint8[]',
      Array.from({ length: LIMITS.maxArrayLength + 1 }, () => 1),
    ),
    /exceeds length limit/,
  );
  rejects(payloadWith('uint8[]', [1, undefined]), /unsupported uint8 value/);
  rejects(payloadWith('uint8[]', new Array(2)), /unsupported uint8 value/);
  rejects(payloadWith('uint8[]', {}), /expects array/);
  accepts(
    payloadWith(
      'uint8[256]',
      Array.from({ length: 256 }, () => 1),
    ),
  );
  const payload = payloadWith();
  payload.types['Payload'] = Array.from({ length: 8 }, (_, i) => ({
    name: `list${i}`,
    type: 'uint8[]',
  }));
  payload.message = Object.fromEntries(
    Array.from({ length: 8 }, (_, i) => [
      `list${i}`,
      Array.from({ length: i === 7 ? 245 : 256 }, () => 1),
    ]),
  );
  accepts(payload); // 2048 visits, including struct and array containers.
  payload.message['list7'] = Array.from({ length: 246 }, () => 1);
  rejects(payload, /too many encoded values/);
});

test('dynamic UTF-8 and bytes limits and exact fixed-byte lengths', () => {
  rejects(payloadWith('string', 'a'.repeat(LIMITS.maxDynamicBytes + 1)), /byte limit/);
  rejects(payloadWith('string', '€'.repeat(Math.ceil(LIMITS.maxDynamicBytes / 3))), /byte limit/);
  rejects(payloadWith('bytes', `0x${'aa'.repeat(LIMITS.maxDynamicBytes + 1)}`), /byte limit/);
  accepts(payloadWith('string', 'a'.repeat(LIMITS.maxDynamicBytes)));
  accepts(payloadWith('string', '€'.repeat(5461) + 'a'));
  accepts(payloadWith('bytes', `0x${'aa'.repeat(LIMITS.maxDynamicBytes)}`));
  for (const value of ['abcd', '0Xab', '0xabc', '0xzz'])
    rejects(payloadWith('bytes', value), /invalid hex/);
  rejects(payloadWith('bytes4', '0x00'), /requires 4 bytes/);
  rejects(payloadWith('bytes4', '0x0000000000'), /byte limit/);
  rejects(payloadWith('bytes', 1), /expects 0x-hex/);
  rejects(payloadWith('string', 1), /expects string/);
});

test('integer widths and exact signed/unsigned ranges, safe numbers and string lengths', () => {
  for (let width = 8; width <= 256; width += 8) {
    const limit = 1n << BigInt(width);
    const signedLimit = limit / 2n;
    accepts(payloadWith(`uint${width}`, limit - 1n));
    accepts(payloadWith(`int${width}`, -signedLimit));
    accepts(payloadWith(`int${width}`, signedLimit - 1n));
    rejects(payloadWith(`uint${width}`, limit), /out of range/);
    rejects(payloadWith(`uint${width}`, -1), /out of range/);
    rejects(payloadWith(`int${width}`, -signedLimit - 1n), /out of range/);
    rejects(payloadWith(`int${width}`, signedLimit), /out of range/);
  }
  for (const value of [NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])
    rejects(payloadWith('uint256', value), /unsafe uint256 number/);
  for (const value of ['01', '+1', ' 1', '1.0', '1e2'])
    rejects(payloadWith('uint256', value), /invalid uint256 string/);
  rejects(payloadWith('uint256', '0'.repeat(81)), /value is too long/);
  accepts(payloadWith('uint256', `0x${'0'.repeat(78)}`));
  accepts(payloadWith('int8', '-0X80'));
  rejects(payloadWith('int8', '-0x81'), /out of range/);
  rejects(payloadWith('bool', 1), /expects boolean/);
  rejects(payloadWith('address', `Q${'0'.repeat(40)}`), /invalid Q-address/);
});

test('missing and unsigned fields fail at every struct level', () => {
  rejects({ ...payloadWith(), message: {} }, /missing field/);
  rejects({ ...payloadWith(), message: { value: 1, extra: true } }, /unknown field/);
  rejects({ ...payloadWith(), domain: { name: 'test', hidden: true } }, /unknown field/);
  const nested = payloadWith('Item', { value: 1, hidden: true });
  nested.types['Item'] = [{ name: 'value', type: 'uint8' }];
  rejects(nested, /unknown field/);
  nested.message['value'] = [];
  rejects(nested, /expects object/);
});
