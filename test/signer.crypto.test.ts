/**
 * Signer crypto smoke test. Runs under `node --test --import tsx` with NO
 * Electron: it imports the signer's pure-crypto modules by their real src
 * paths and exercises the three load-bearing primitives end to end.
 *
 *   1. KDF determinism  (src/signer/kdf.ts)
 *   2. AEAD round-trip + tamper detection  (src/signer/aead.ts)
 *   3. signMessage produces a signature that ML-DSA-87 verifies against the
 *      returned public key, the recomputed SHAKE256 digest, and the
 *      QRL-SIGN-MSG-v1 context  (src/signer/signing.ts)
 *
 * The KDF + AEAD checks ALWAYS run. The signing check generates a valid QRL
 * mnemonic at runtime via @theqrl/wallet.js (MLDSA87.newWallet().getMnemonic()),
 * so it is self-contained; QRL_TEST_MNEMONIC overrides that if a fixed vector
 * is preferred.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as mldsa from '@theqrl/mldsa87';
import { MLDSA87 } from '@theqrl/wallet.js';
import { shake256 } from '@noble/hashes/sha3.js';

import { deriveKek } from '../src/signer/kdf';
import { aesGcmEncrypt, aesGcmDecrypt, AeadAuthError } from '../src/signer/aead';
import {
  deriveSeedFromHexSeed,
  deriveSeedFromMnemonic,
  generateMnemonic,
  signMessage,
} from '../src/signer/signing';
import { KDF_DEFAULTS, MLDSA87 as SIZES, SCHEME } from '../src/shared/constants';
import type { KdfParams } from '../src/shared/constants';

// A deliberately tiny memoryCost so the test is fast. We are checking
// determinism and length, not the production hardening factor. KdfParams pins
// the production literals, so widen with a structural cast for the override.
const FAST_KDF: KdfParams = {
  ...KDF_DEFAULTS,
  memoryCost: 8192,
  timeCost: 1,
} as unknown as KdfParams;

const SCHEME_TAG_MSG = new TextEncoder().encode(SCHEME.TAG_MSG);

function hexToBytes(hex: string): Uint8Array {
  const body = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

test('deriveKek is deterministic for a fixed password+salt+params', async () => {
  const salt = Buffer.from('0123456789abcdef0123456789abcdef', 'hex'); // 16 bytes
  const a = await deriveKek('correct horse battery staple', salt, FAST_KDF);
  const b = await deriveKek('correct horse battery staple', salt, FAST_KDF);

  assert.equal(a.length, KDF_DEFAULTS.outputLen, 'KEK must be 32 bytes');
  assert.ok(a.equals(b), 'same password+salt+params must yield identical KEK bytes');

  const different = await deriveKek('a different password', salt, FAST_KDF);
  assert.ok(!a.equals(different), 'a different password must yield a different KEK');
});

test('aesGcmEncrypt / aesGcmDecrypt round-trips and rejects tampering', async () => {
  const salt = Buffer.from('ffeeddccbbaa99887766554433221100', 'hex');
  const kek = await deriveKek('unlock-me', salt, FAST_KDF);

  const plaintext = Buffer.from('51-byte-extended-seed-stand-in-secret-material', 'utf8');
  const env = aesGcmEncrypt(plaintext, kek);

  assert.equal(env.iv.length, 12, 'GCM nonce must be 12 bytes');
  assert.equal(env.tag.length, 16, 'GCM tag must be 16 bytes');
  assert.ok(!env.ciphertext.equals(plaintext), 'ciphertext must differ from plaintext');

  const decrypted = aesGcmDecrypt(env, kek);
  assert.ok(decrypted.equals(plaintext), 'decrypt must recover the exact plaintext');

  // Flip one bit of the auth tag: GCM must reject it as AeadAuthError.
  const badTag = Buffer.from(env.tag);
  badTag[0] = (badTag[0] ?? 0) ^ 0x01;
  assert.throws(
    () => aesGcmDecrypt({ iv: env.iv, ciphertext: env.ciphertext, tag: badTag }, kek),
    AeadAuthError,
    'a tampered tag must throw AeadAuthError',
  );

  // A wrong KEK must also fail authentication, not return garbage.
  const wrongKek = await deriveKek('wrong-password', salt, FAST_KDF);
  assert.throws(() => aesGcmDecrypt(env, wrongKek), AeadAuthError, 'a wrong KEK must throw');
});

test('signMessage produces an ML-DSA-87 signature that verifies', () => {
  // Self-contained: generate a valid QRL mnemonic unless one is supplied.
  const mnemonic = process.env.QRL_TEST_MNEMONIC ?? MLDSA87.newWallet().getMnemonic();

  // deriveSeedFromMnemonic must NOT throw: a throw here (e.g. an address
  // derivation / checksum regression) should fail the test, not be swallowed.
  const { hexSeed, address } = deriveSeedFromMnemonic(mnemonic);
  assert.ok(address.startsWith('Q'), 'derived address must be Q-prefixed');

  const messageHex = '0x' + Buffer.from('hello quantum world', 'utf8').toString('hex');
  const result = signMessage(hexSeed, messageHex);

  assert.equal(result.kind, 'message');
  assert.ok(result.publicKey, 'message signature must include the public key');
  assert.ok(result.digest, 'message signature must include the digest');
  assert.equal(result.signer, address, 'signer must match the derived address');

  const sig = hexToBytes(result.signature);
  const pk = hexToBytes(result.publicKey!);
  assert.equal(sig.length, SIZES.SIGNATURE_BYTES, 'signature must be 4627 bytes');
  assert.equal(pk.length, SIZES.PUBLIC_KEY_BYTES, 'public key must be 2592 bytes');

  // Recompute the digest the signer hashed: SHAKE256(ctx || message, 64).
  const messageBytes = hexToBytes(messageHex);
  const digest = shake256(concat(SCHEME_TAG_MSG, messageBytes), { dkLen: SIZES.DIGEST_BYTES });
  assert.equal(result.digest, '0x' + Buffer.from(digest).toString('hex'), 'digest must match');

  // Verify with the same context tag the signer used.
  const ok = mldsa.cryptoSignVerify(sig, digest, pk, SCHEME_TAG_MSG);
  assert.equal(ok, true, 'ML-DSA-87 must accept the signature over the digest + ctx');

  // Negative control: a flipped digest byte must NOT verify.
  const badDigest = new Uint8Array(digest);
  badDigest[0] = (badDigest[0] ?? 0) ^ 0x01;
  assert.equal(
    mldsa.cryptoSignVerify(sig, badDigest, pk, SCHEME_TAG_MSG),
    false,
    'verification must fail for a tampered digest',
  );
});

test('generateMnemonic (signer create op) yields a usable, signing wallet', () => {
  // The desktop "create wallet" flow generates the seed inside the signer via
  // generateMnemonic() and returns only the mnemonic. Verify the generated
  // mnemonic is valid: it must derive a Q-address and a key that signs.
  const m1 = generateMnemonic();
  const m2 = generateMnemonic();
  assert.ok(m1.trim().length > 0, 'mnemonic must be non-empty');
  assert.notEqual(m1, m2, 'each generation must produce a fresh mnemonic');

  const { hexSeed, address } = deriveSeedFromMnemonic(m1);
  assert.ok(address.startsWith('Q'), 'generated wallet must derive a Q-address');

  const messageHex = '0x' + Buffer.from('create-op smoke', 'utf8').toString('hex');
  const result = signMessage(hexSeed, messageHex);
  const ok = mldsa.cryptoSignVerify(
    hexToBytes(result.signature),
    shake256(concat(SCHEME_TAG_MSG, hexToBytes(messageHex)), { dkLen: SIZES.DIGEST_BYTES }),
    hexToBytes(result.publicKey!),
    SCHEME_TAG_MSG,
  );
  assert.equal(ok, true, 'a generated wallet must produce a verifiable signature');
});

test('hex-seed import derives the same identity as the mnemonic (two encodings, one wallet)', () => {
  // The mnemonic and the 51-byte extended seed encode the same bytes, so the
  // desktop's hex-seed import route must land on the identical account AND
  // regenerate the canonical recovery phrase for the stored envelope.
  const mnemonic = generateMnemonic();
  const fromMnemonic = deriveSeedFromMnemonic(mnemonic);
  const fromHex = deriveSeedFromHexSeed(fromMnemonic.hexSeed);

  assert.equal(fromHex.address, fromMnemonic.address, 'same address from either encoding');
  assert.equal(fromHex.hexSeed, fromMnemonic.hexSeed, 'seed round-trips unchanged');
  assert.equal(fromHex.mnemonic, fromMnemonic.mnemonic, 'canonical mnemonic regenerated');

  // The bare (un-prefixed) hex form must be accepted too: the web wallet's
  // hex-seed import field is typically pasted without 0x.
  const bare = fromMnemonic.hexSeed.replace(/^0x/, '');
  assert.equal(deriveSeedFromHexSeed(bare).address, fromMnemonic.address);

  // Malformed input fails loudly rather than deriving a garbage wallet.
  assert.throws(() => deriveSeedFromHexSeed('0x' + 'ab'.repeat(50)), /invalid hex extended seed/);
  assert.throws(() => deriveSeedFromHexSeed('zz'.repeat(51)), /invalid hex extended seed/);
});
