import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CreateWalletRequestSchema,
  ImportWalletRequestSchema,
  SignatureRequestSchema,
  UnlockRequestSchema,
} from '../src/shared/schemas';
import { parseSignerRequest } from '../src/shared/protocolGuards';

const astral = '\u{1f600}';
const address = `Q${'a'.repeat(128)}`;

test('provisioning and unlock preserve the native password cap for astral text', () => {
  const password = astral.repeat(512);
  for (const schema of [CreateWalletRequestSchema, UnlockRequestSchema]) {
    assert.equal(schema.safeParse({ password }).success, true);
    const rejected = schema.safeParse({ password: password + 'a' });
    assert.equal(rejected.success, false);
    const [issue] = rejected.error.issues;
    assert.ok(issue);
    assert.equal(issue.code, 'too_big');
    assert.deepEqual(issue.path, ['password']);
  }
  const source = { hexSeed: 'ab'.repeat(51) };
  assert.equal(ImportWalletRequestSchema.safeParse({ ...source, password }).success, true);
  assert.equal(
    ImportWalletRequestSchema.safeParse({ ...source, password: password + 'a' }).success,
    false,
  );
});

test('mnemonic input keeps its UTF-16 cap before wallet derivation', () => {
  const mnemonic = astral.repeat(2048);
  assert.equal(ImportWalletRequestSchema.safeParse({ mnemonic, password: 'pw' }).success, true);
  assert.equal(
    ImportWalletRequestSchema.safeParse({ mnemonic: mnemonic + 'a', password: 'pw' }).success,
    false,
  );
});

test('main and signer preserve dApp origin text caps for astral input', () => {
  const origin = {
    via: 'dapp',
    name: astral.repeat(32),
    url: 'https://example.com/' + astral.repeat(118),
    channelId: 'abcdef',
  };
  const request = { kind: 'message', messageHex: '0xab', signer: address, origin };
  const wire = { type: 'signer:sign', id: 1, chainId: 3151909, request };
  assert.equal(SignatureRequestSchema.safeParse(request).success, true);
  assert.notEqual(parseSignerRequest(wire), null);
  for (const key of ['name', 'url'] as const) {
    const oversized = { ...request, origin: { ...origin, [key]: origin[key] + 'a' } };
    const rejected = SignatureRequestSchema.safeParse(oversized);
    assert.equal(rejected.success, false);
    const [issue] = rejected.error.issues;
    assert.ok(issue);
    assert.equal(issue.code, 'too_big');
    assert.deepEqual(issue.path, ['origin', key]);
    assert.equal(parseSignerRequest({ ...wire, request: oversized }), null);
  }
});
