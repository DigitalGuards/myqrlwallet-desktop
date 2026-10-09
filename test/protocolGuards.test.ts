/**
 * Runtime guards on the private main <-> signer channel and the persisted
 * envelope. Every malformed shape must be rejected (fail closed), and a valid
 * shape must round-trip with no extra or missing fields.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { KDF_DEFAULTS, SEED_FILE_VERSION } from '../src/shared/constants';
import { isArray, errorCode, isRecord } from '../src/shared/guards';
import type { EncryptedSeed } from '../src/shared/protocol';
import {
  isEncryptedSeed,
  parseCreateResult,
  parseNullResult,
  parseSignerMessage,
  parseSignerRequest,
  parseSignerStatus,
  parseUnlockResult,
} from '../src/shared/protocolGuards';

const ADDRESS = `Q${'ab'.repeat(64)}`;
const AEAD_FIELDS = { iv: 'aa', ciphertext: 'bb', tag: 'cc' };

function envelope(): EncryptedSeed {
  return {
    version: SEED_FILE_VERSION,
    address: ADDRESS,
    kdf: { ...KDF_DEFAULTS },
    salt: '00'.repeat(16),
    seed: { ...AEAD_FIELDS },
    mnemonic: { ...AEAD_FIELDS },
    createdAt: 1,
  };
}

test('isEncryptedSeed accepts a well-formed envelope, with or without createdAt', () => {
  assert.equal(isEncryptedSeed(envelope()), true);
  const { createdAt: _createdAt, ...legacy } = envelope();
  assert.equal(isEncryptedSeed(legacy), true);
});

test('isEncryptedSeed rejects wrong shapes', () => {
  assert.equal(isEncryptedSeed(null), false);
  assert.equal(isEncryptedSeed([]), false);
  assert.equal(isEncryptedSeed({ ...envelope(), address: `Q${'ab'.repeat(20)}` }), false);
  assert.equal(isEncryptedSeed({ ...envelope(), kdf: {} }), false);
  assert.equal(isEncryptedSeed({ ...envelope(), kdf: { ...KDF_DEFAULTS, memoryCost: 0 } }), false);
  assert.equal(isEncryptedSeed({ ...envelope(), kdf: { ...KDF_DEFAULTS, timeCost: 'x' } }), false);
  assert.equal(isEncryptedSeed({ ...envelope(), seed: { iv: 'aa' } }), false);
  assert.equal(isEncryptedSeed({ ...envelope(), createdAt: 'now' }), false);
});

test('parseSignerRequest accepts each request type and rejects bad ids', () => {
  assert.deepEqual(parseSignerRequest({ type: 'signer:lock', id: 3 }), {
    type: 'signer:lock',
    id: 3,
  });
  assert.deepEqual(parseSignerRequest({ type: 'signer:create', id: 1, password: 'pw' }), {
    type: 'signer:create',
    id: 1,
    password: 'pw',
  });
  assert.equal(parseSignerRequest({ type: 'signer:lock', id: '3' }), null);
  assert.equal(parseSignerRequest({ type: 'signer:lock', id: 1.5 }), null);
  assert.equal(parseSignerRequest({ type: 'signer:lock' }), null);
  assert.equal(parseSignerRequest({ type: 'signer:nope', id: 1 }), null);
  assert.equal(parseSignerRequest('signer:lock'), null);
  assert.equal(parseSignerRequest(null), null);
});

test('parseSignerRequest omits absent optional fields', () => {
  const req = parseSignerRequest({ type: 'signer:import', id: 2, password: 'pw', hexSeed: 'ab' });
  assert.deepEqual(req, { type: 'signer:import', id: 2, password: 'pw', hexSeed: 'ab' });
  assert.equal(req !== null && 'mnemonic' in req, false);
  assert.equal(
    parseSignerRequest({ type: 'signer:import', id: 2, password: 'pw', hexSeed: 7 }),
    null,
  );
});

test('parseSignerRequest validates unlock fields', () => {
  const base = { type: 'signer:unlock', id: 4, encrypted: envelope(), autolockMs: 60_000 };
  assert.deepEqual(parseSignerRequest({ ...base, password: 'pw' }), { ...base, password: 'pw' });
  assert.equal(parseSignerRequest({ ...base, autolockMs: 0 }), null);
  assert.equal(parseSignerRequest({ ...base, autolockMs: Number.NaN }), null);
  assert.equal(parseSignerRequest({ ...base, encrypted: { ...envelope(), kdf: null } }), null);
  assert.equal(parseSignerRequest({ ...base, wantKek: 'yes' }), null);
  assert.equal(parseSignerRequest({ ...base, kekHex: 5 }), null);
});

test('parseSignerRequest validates sign requests with the shared schema', () => {
  const request = { kind: 'message', messageHex: '0x00', signer: ADDRESS };
  assert.deepEqual(parseSignerRequest({ type: 'signer:sign', id: 5, request, chainId: 7 }), {
    type: 'signer:sign',
    id: 5,
    request,
    chainId: 7,
  });
  assert.equal(
    parseSignerRequest({ type: 'signer:sign', id: 5, request: { kind: 'message' }, chainId: 7 }),
    null,
  );
  assert.equal(parseSignerRequest({ type: 'signer:sign', id: 5, request, chainId: -1 }), null);
  assert.equal(
    parseSignerRequest({
      type: 'signer:sign',
      id: 5,
      request: { ...request, extra: true },
      chainId: 7,
    }),
    null,
  );
});

test('parseSignerRequest bounds the autolock re-arm', () => {
  assert.notEqual(
    parseSignerRequest({ type: 'signer:setAutolock', id: 1, autolockMs: 1000 }),
    null,
  );
  assert.equal(parseSignerRequest({ type: 'signer:setAutolock', id: 1, autolockMs: -1 }), null);
  assert.equal(
    parseSignerRequest({ type: 'signer:setAutolock', id: 1, autolockMs: Infinity }),
    null,
  );
});

test('parseSignerMessage classifies signer output and drops malformed output', () => {
  assert.deepEqual(parseSignerMessage({ type: 'signer:ready' }), { kind: 'ready' });
  assert.deepEqual(parseSignerMessage({ type: 'signer:autolock' }), { kind: 'autolock' });
  assert.deepEqual(parseSignerMessage({ id: 1, ok: true, type: 'signer:lock', result: null }), {
    kind: 'ok',
    id: 1,
    result: null,
  });
  assert.deepEqual(parseSignerMessage({ id: 2, ok: false, error: 'locked' }), {
    kind: 'err',
    id: 2,
    error: 'locked',
  });
  assert.equal(parseSignerMessage({ id: 2, ok: false }), null);
  assert.equal(parseSignerMessage({ id: '2', ok: true }), null);
  assert.equal(parseSignerMessage({ ok: true }), null);
  assert.equal(parseSignerMessage('hi'), null);
  assert.equal(parseSignerMessage(undefined), null);
});

test('result parsers reject malformed signer results', () => {
  assert.equal(parseNullResult(null), null);
  assert.throws(() => parseNullResult({}), /malformed/);
  assert.throws(() => parseCreateResult({ address: ADDRESS }), /malformed/);
  assert.deepEqual(
    parseCreateResult({ address: ADDRESS, encrypted: envelope(), mnemonic: 'a b c' }),
    { address: ADDRESS, encrypted: envelope(), mnemonic: 'a b c' },
  );
  assert.deepEqual(parseUnlockResult({ address: ADDRESS, unlockExpiresAt: 9 }), {
    address: ADDRESS,
    unlockExpiresAt: 9,
  });
  assert.deepEqual(parseUnlockResult({ address: ADDRESS, unlockExpiresAt: 9, kekHex: 'ff' }), {
    address: ADDRESS,
    unlockExpiresAt: 9,
    kekHex: 'ff',
  });
  assert.throws(() => parseUnlockResult({ address: ADDRESS, unlockExpiresAt: '9' }), /malformed/);
  assert.throws(() => parseUnlockResult({ address: 'Q1', unlockExpiresAt: 9 }), /malformed/);
  assert.deepEqual(parseSignerStatus({ unlocked: false, address: null, unlockExpiresAt: null }), {
    unlocked: false,
    address: null,
    unlockExpiresAt: null,
  });
  assert.throws(() => parseSignerStatus({ unlocked: 'no' }), /malformed/);
});

test('shared guards', () => {
  assert.equal(isRecord({}), true);
  assert.equal(isRecord([]), false);
  assert.equal(isRecord(null), false);
  assert.equal(isArray([1]), true);
  assert.equal(isArray({}), false);
  assert.equal(errorCode(Object.assign(new Error('x'), { code: 'ENOENT' })), 'ENOENT');
  assert.equal(errorCode(new Error('x')), undefined);
  assert.equal(errorCode('ENOENT'), undefined);
});
