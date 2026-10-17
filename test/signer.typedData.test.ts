import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as mldsa from '@theqrl/mldsa87';
import { shake256 } from '@noble/hashes/sha3.js';
import { toChecksumAddress } from '@theqrl/wallet.js';
import { SCHEME } from '../src/shared/constants';
import { KDF_DEFAULTS, SEED_FILE_VERSION } from '../src/shared/constants';
import { parseSignerRequest } from '../src/shared/protocolGuards';
import type { EncryptedSeed } from '../src/shared/protocol';
import { EXPECTED_CHAIN_ID } from '../src/main/config';
import { summariseSignatureRequest } from '../src/main/confirmSummary';
import { SignerSession } from '../src/signer/session';
import { aesGcmEncrypt } from '../src/signer/aead';
import { signRequest } from '../src/signer/signRequest';
import { parseSignatureResultForRequest, SignatureResultSchema } from '../src/shared/schemas';
import { encodeType, typedDataSchemeVersion } from '../src/shared/typedData';
import { signTypedData } from '../src/signer/signing';
import { computeTypedDataDigest, typedDataSchemeTag, typeHash } from '../src/signer/typedData';
import { canonical, payloadWith, typedRequest } from './typedDataFixtures';

const hex = (bytes: Uint8Array): string => `0x${Buffer.from(bytes).toString('hex')}`;
const bytes = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value.slice(2), 'hex'));

/** SDK ForSigner logic: fixed wire sizes, descriptor/key address binding,
 * payload-selected scheme, recomputed digest, and ML-DSA-87 context verification. */
function verifyForSigner(value: unknown, payload: unknown, expectedSigner: string): boolean {
  try {
    const result = SignatureResultSchema.parse(value);
    if (result.kind !== 'typedData') return false;
    const scheme = typedDataSchemeVersion(payload);
    if (scheme !== result.schemeVersion) return false;
    const key = bytes(result.publicKey);
    const identity = shake256(Buffer.concat([bytes(result.descriptor), key]), { dkLen: 64 });
    const derived = `Q${Buffer.from(identity).toString('hex')}`;
    return (
      derived.toLowerCase() === expectedSigner.toLowerCase() &&
      mldsa.cryptoSignVerify(
        bytes(result.signature),
        computeTypedDataDigest(payload),
        key,
        typedDataSchemeTag(scheme),
      )
    );
  } catch {
    return false;
  }
}

for (const vector of canonical.schemeVectors) {
  test(`canonical digest: ${vector.label}`, () => {
    assert.equal(typedDataSchemeVersion(vector.payload), vector.schemeVersion);
    assert.equal(
      encodeType(vector.payload.primaryType, vector.payload.types),
      vector.encodeTypeString,
    );
    assert.equal(
      hex(typeHash(vector.payload.primaryType, vector.payload.types)),
      vector.typeHashHex,
    );
    assert.equal(hex(computeTypedDataDigest(vector.payload)), vector.digestHex);
    const tag = typedDataSchemeTag(vector.schemeVersion);
    assert.equal(
      hex(
        shake256(Buffer.concat([tag, bytes(vector.domainHashHex), bytes(vector.messageHashHex)]), {
          dkLen: 64,
        }),
      ),
      vector.digestHex,
    );
  });
}

for (const vector of canonical.schemeSigningVectors) {
  test(`canonical deterministic signature: ${vector.label}`, () => {
    const { hexSeed, payload, label: _label, ...expected } = vector;
    const result = signTypedData(hexSeed, payload, false);
    assert.deepEqual(result, { kind: 'typedData', ...expected });
    assert.deepEqual(signTypedData(hexSeed, payload, false), result);
    assert.deepEqual(
      parseSignatureResultForRequest(result, typedRequest(payload, vector.signer)),
      result,
    );
    assert.equal(verifyForSigner(result, payload, vector.signer), true);

    const other =
      result.schemeVersion === SCHEME.TAG_TYPED ? SCHEME.TAG_TYPED_V2 : SCHEME.TAG_TYPED;
    assert.equal(
      verifyForSigner({ ...result, schemeVersion: other }, payload, vector.signer),
      false,
    );
    assert.throws(
      () =>
        parseSignatureResultForRequest(
          { ...result, schemeVersion: other },
          typedRequest(payload, vector.signer),
        ),
      /different typed-data scheme/,
    );
    assert.equal(
      mldsa.cryptoSignVerify(
        bytes(result.signature),
        bytes(result.digest),
        bytes(result.publicKey),
        typedDataSchemeTag(other),
      ),
      false,
    );
    assert.equal(
      mldsa.cryptoSignVerify(
        bytes(result.signature),
        bytes(result.digest),
        bytes(result.publicKey),
        new TextEncoder().encode(SCHEME.TAG_MSG),
      ),
      false,
    );
    const altered = structuredClone(payload);
    altered.domain['name'] = 'Changed domain';
    assert.equal(verifyForSigner(result, altered, vector.signer), false);
    const changedMessage = structuredClone(payload);
    changedMessage.message[payload.primaryType === 'Vote' ? 'proposal' : 'nonce'] = '8';
    assert.equal(verifyForSigner(result, changedMessage, vector.signer), false);
    assert.equal(verifyForSigner(result, payload, `Q${'0'.repeat(128)}`), false);
    assert.equal(
      verifyForSigner({ ...result, descriptor: '0x010001' }, payload, vector.signer),
      false,
    );
    assert.equal(
      verifyForSigner({ ...result, descriptor: undefined }, payload, vector.signer),
      false,
    );
    assert.equal(verifyForSigner({ ...result, publicKey: '0x00' }, payload, vector.signer), false);

    const hedged = signTypedData(hexSeed, payload);
    const second = signTypedData(hexSeed, payload);
    assert.notEqual(hedged.signature, second.signature);
    assert.equal(verifyForSigner(hedged, payload, vector.signer), true);
    assert.equal(verifyForSigner(second, payload, vector.signer), true);
  });
}

test('legacy address fixtures stay rejected', () => {
  for (const vector of canonical.typedVectors) {
    assert.throws(() => computeTypedDataDigest(vector.payload), /invalid Q-address/);
  }
});

test('address arrays and domain-only addresses select v2; address-looking strings keep v1', () => {
  assert.equal(typedDataSchemeVersion(payloadWith('address[]', [])), SCHEME.TAG_TYPED_V2);
  assert.equal(
    typedDataSchemeVersion(payloadWith('string', `Q${'a'.repeat(128)}`)),
    SCHEME.TAG_TYPED,
  );
});

test('signer enforces checksum casing in nested addresses', () => {
  const lower = `Q${'a1'.repeat(64)}`;
  const checked = toChecksumAddress(lower);
  assert.notEqual(checked, lower);
  assert.deepEqual(
    computeTypedDataDigest(payloadWith('address[]', [lower])),
    computeTypedDataDigest(payloadWith('address[]', [checked])),
  );
  const bad = `QaA${'a1'.repeat(63)}`;
  assert.throws(() => computeTypedDataDigest(payloadWith('address[]', [bad])), /checksum casing/);
});

test('malformed payload fails before seed derivation', () => {
  assert.throws(() => signTypedData('invalid seed', payloadWith('uint8', 256)), /out of range/);
});

test('production signRequest rejects malformed payloads before session seed access', async (t) => {
  const vector = canonical.schemeSigningVectors[0];
  assert.ok(vector);
  const session = new SignerSession(() => {
    // This test exercises signing with an explicitly controlled session.
  });
  t.mock.getter(session, 'unlocked', () => true);
  t.mock.getter(session, 'address', () => vector.signer);
  const seedAccess = t.mock.method(session, 'withSeed', () => {
    throw new Error('seed decryption reached');
  });
  for (const [payload, error] of [
    [payloadWith('uint8', 256), /out of range/],
    [payloadWith('address', `QaA${'a1'.repeat(63)}`), /checksum casing/],
    [payloadWith('[]'.repeat(500000) + 'x'), /field type too long/],
    [payloadWith('Payload', {}), /cyclic type reference/],
  ] as const) {
    await assert.rejects(
      signRequest(
        session,
        { kind: 'typedData', signer: vector.signer, payload },
        EXPECTED_CHAIN_ID,
        Date.now(),
      ),
      error,
    );
    assert.equal(seedAccess.mock.callCount(), 0);
  }
  await assert.rejects(
    signRequest(
      session,
      typedRequest(vector.payload, vector.signer),
      EXPECTED_CHAIN_ID,
      Date.now(),
    ),
    /seed decryption reached/,
  );
  assert.equal(seedAccess.mock.callCount(), 1);
});

test('production signRequest prepares its digest and scheme before the seed callback', async (t) => {
  const vector = canonical.schemeSigningVectors[0];
  assert.ok(vector);
  const payload = payloadWith('uint8', 1);
  const original = structuredClone(payload);
  const session = new SignerSession(() => {
    // This test exercises signing with an explicitly controlled session.
  });
  t.mock.getter(session, 'unlocked', () => true);
  t.mock.getter(session, 'address', () => vector.signer);
  const seedAccess = t.mock.method(session, 'withSeed', <T>(fn: (seed: string) => T): T => {
    // Changing the source after preparation cannot change the prepared signature.
    payload.types['Payload'] = [{ name: 'value', type: 'address' }];
    payload.message['value'] = 'invalid';
    return fn(vector.hexSeed);
  });
  const result = await signRequest(
    session,
    { kind: 'typedData', signer: vector.signer, payload },
    EXPECTED_CHAIN_ID,
    Date.now(),
  );
  assert.equal(seedAccess.mock.callCount(), 1);
  assert.equal<unknown>(result.kind, 'typedData');
  assert.ok(result.kind === 'typedData');
  assert.equal(result.schemeVersion, SCHEME.TAG_TYPED);
  assert.equal(result.digest, hex(computeTypedDataDigest(original)));
  assert.equal(verifyForSigner(result, original, vector.signer), true);
});

test('validated request -> trusted summary -> session signer -> SDK-style verification', async () => {
  const vector = canonical.schemeSigningVectors[0];
  assert.ok(vector);
  const session = new SignerSession(() => {
    // This test exercises signing with an explicitly controlled session.
  });
  const request = typedRequest(vector.payload, vector.signer);
  await assert.rejects(signRequest(session, request, EXPECTED_CHAIN_ID, Date.now()), /locked/);
  const kek = Buffer.alloc(32, 7);
  const seal = (text: string) => {
    const encrypted = aesGcmEncrypt(Buffer.from(text, 'utf8'), kek);
    return {
      iv: Buffer.from(encrypted.iv).toString('hex'),
      ciphertext: Buffer.from(encrypted.ciphertext).toString('hex'),
      tag: Buffer.from(encrypted.tag).toString('hex'),
    };
  };
  const envelope: EncryptedSeed = {
    version: SEED_FILE_VERSION,
    address: vector.signer,
    kdf: { ...KDF_DEFAULTS },
    salt: '00'.repeat(16),
    seed: seal(vector.hexSeed),
    mnemonic: seal('public fixture'),
  };
  try {
    await session.unlock(envelope, 60_000, { kek }, Date.now());
    const wire = parseSignerRequest({
      type: 'signer:sign',
      id: 1,
      request,
      chainId: EXPECTED_CHAIN_ID,
    });
    assert.ok(wire?.type === 'signer:sign');
    assert.match(
      summariseSignatureRequest(wire.request, {
        connectedChainId: EXPECTED_CHAIN_ID,
      }).pages.join('\n'),
      /Scheme: +QRL-SIGN-TYPED-v2/,
    );
    const result = await signRequest(session, wire.request, wire.chainId, Date.now());
    assert.deepEqual(parseSignatureResultForRequest(result, request), result);
    assert.equal(verifyForSigner(result, vector.payload, vector.signer), true);
    await assert.rejects(
      signRequest(session, typedRequest(vector.payload), EXPECTED_CHAIN_ID, Date.now()),
      /account mismatch/,
    );
    const messageWire = parseSignerRequest({
      type: 'signer:sign',
      id: 2,
      chainId: EXPECTED_CHAIN_ID,
      request: { kind: 'message', signer: vector.signer, messageHex: '0x6869' },
    });
    assert.ok(messageWire?.type === 'signer:sign');
    const message = await signRequest(
      session,
      messageWire.request,
      messageWire.chainId,
      Date.now(),
    );
    assert.equal(message.kind, 'message');
    session.lock();
    await assert.rejects(signRequest(session, request, EXPECTED_CHAIN_ID, Date.now()), /locked/);
  } finally {
    session.lock();
    kek.fill(0);
  }
});
