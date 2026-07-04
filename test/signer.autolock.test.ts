/**
 * SET_AUTOLOCK protocol arm behaviour test: the live re-arm of an open signer
 * session when the settings window changes the autolock timeout. Mirrors the
 * fixture + mock-timer patterns of test/signer.session.test.ts.
 *
 * Verified here:
 *   - the wire constant and request shape of the new arm
 *   - setAutolock while locked is a no-op (no throw, stays locked)
 *   - shrinking the bound re-arms immediately (fires at the NEW, shorter bound)
 *   - growing the bound moves the deadline out past the old one
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { deriveKek } from '../src/signer/kdf';
import { aesGcmEncrypt } from '../src/signer/aead';
import { deriveSeedFromMnemonic, generateMnemonic } from '../src/signer/signing';
import { SignerSession } from '../src/signer/session';
import { KDF_DEFAULTS, SEED_FILE_VERSION, SIGNER_MSG } from '../src/shared/constants';
import type { KdfParams } from '../src/shared/constants';
import type { EncryptedSeed, SetAutolockReq } from '../src/shared/protocol';

// Tiny memoryCost so the KDF is fast; we test re-arm logic, not hardening.
const FAST_KDF: KdfParams = {
  ...KDF_DEFAULTS,
  memoryCost: 8192,
  timeCost: 1,
} as unknown as KdfParams;

const PASSWORD = 'correct horse battery staple';

async function makeFixture(): Promise<EncryptedSeed> {
  const { hexSeed, address } = deriveSeedFromMnemonic(generateMnemonic());
  const salt = randomBytes(KDF_DEFAULTS.saltBytes);
  const kek = await deriveKek(PASSWORD, salt, FAST_KDF);
  const seedEnv = aesGcmEncrypt(Buffer.from(hexSeed, 'utf8'), kek);
  const mnemonicEnv = aesGcmEncrypt(Buffer.from('unused in autolock path', 'utf8'), kek);
  const toFields = (e: typeof seedEnv) => ({
    iv: e.iv.toString('hex'),
    ciphertext: e.ciphertext.toString('hex'),
    tag: e.tag.toString('hex'),
  });
  return {
    version: SEED_FILE_VERSION,
    address,
    kdf: FAST_KDF,
    salt: salt.toString('hex'),
    seed: toFields(seedEnv),
    mnemonic: toFields(mnemonicEnv),
    createdAt: 0,
  };
}

test('the SET_AUTOLOCK wire constant and request shape are as specified', () => {
  assert.equal(SIGNER_MSG.SET_AUTOLOCK, 'signer:setAutolock');
  // Compile-time contract: this literal must satisfy the protocol arm exactly
  // (an extra or missing field is a type error under the strict tsconfig).
  const req: SetAutolockReq = { id: 1, type: 'signer:setAutolock', autolockMs: 60_000 };
  assert.equal(req.autolockMs, 60_000);
});

test('setAutolock while locked is a no-op success (no session to re-arm)', async () => {
  await makeFixture(); // exercise the fixture path; the session stays locked
  const session = new SignerSession(() => {});
  assert.equal(session.unlocked, false);
  assert.doesNotThrow(() => session.setAutolock(60_000, 0));
  assert.equal(session.unlocked, false, 'still locked; nothing was armed');
});

test('shrinking the bound re-arms the open session immediately', async (t) => {
  const encrypted = await makeFixture();
  let fired = 0;
  const session = new SignerSession(() => {
    fired += 1;
  });

  t.mock.timers.enable({ apis: ['setTimeout'] });
  await session.unlock(encrypted, 10_000, { password: PASSWORD }, 0);

  // At +1000ms the settings window shrinks the bound to 1000ms: the session
  // must now expire at +2000ms, not at the original +10000ms.
  t.mock.timers.tick(1_000);
  session.setAutolock(1_000, 1_000);
  assert.equal(session.expiresAt, 2_000, 'deadline recomputed from now + new bound');

  t.mock.timers.tick(999);
  assert.equal(fired, 0, 'not yet');
  t.mock.timers.tick(1);
  assert.equal(fired, 1, 'fires at the NEW shorter bound');
  assert.equal(session.unlocked, false);
});

test('growing the bound moves the deadline past the old one', async (t) => {
  const encrypted = await makeFixture();
  let fired = 0;
  const session = new SignerSession(() => {
    fired += 1;
  });

  t.mock.timers.enable({ apis: ['setTimeout'] });
  await session.unlock(encrypted, 1_000, { password: PASSWORD }, 0);
  session.setAutolock(5_000, 0);

  // Past the ORIGINAL 1000ms bound: the grow moved it out.
  t.mock.timers.tick(1_000);
  assert.equal(fired, 0, 'old bound no longer applies');
  assert.equal(session.unlocked, true);

  t.mock.timers.tick(4_000);
  assert.equal(fired, 1, 'fires at the new longer bound');
  assert.equal(session.unlocked, false);
});
