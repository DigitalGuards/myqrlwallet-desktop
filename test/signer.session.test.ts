/**
 * SignerSession behaviour test: the in-memory unlock lifecycle that gates every
 * signature. It holds the KEK, re-decrypts the seed per sign, slides the
 * autolock timer, and zeroizes on lock. None of this touches Electron, so it
 * runs under `node --test --import tsx`.
 *
 * Verified here:
 *   - unlock with the correct password opens a session and exposes the address
 *   - withSeed yields exactly the stored hex seed and only while unlocked
 *   - a wrong password fails authentication (AeadAuthError), not silent garbage
 *   - lock() drops the session; subsequent withSeed throws 'locked'
 *   - the autolock timer fires onAutoLock and locks (driven by mock timers)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { deriveKek } from '../src/signer/kdf';
import { aesGcmEncrypt, AeadAuthError } from '../src/signer/aead';
import { deriveSeedFromMnemonic, generateMnemonic } from '../src/signer/signing';
import { SignerSession } from '../src/signer/session';
import { KDF_DEFAULTS, SEED_FILE_VERSION } from '../src/shared/constants';
import type { KdfParams } from '../src/shared/constants';
import type { EncryptedSeed } from '../src/shared/protocol';

// Tiny memoryCost so the KDF is fast; we test session logic, not hardening.
const FAST_KDF: KdfParams = {
  ...KDF_DEFAULTS,
  memoryCost: 8192,
  timeCost: 1,
} as unknown as KdfParams;

const PASSWORD = 'correct horse battery staple';

interface Fixture {
  encrypted: EncryptedSeed;
  hexSeed: string;
  address: string;
}

/** Build a real encrypted-seed envelope the way handleImport does, so the
 * session can decrypt it. Kept out of the timer-mocked region (async KDF). */
async function makeFixture(): Promise<Fixture> {
  const { hexSeed, address } = deriveSeedFromMnemonic(generateMnemonic());
  const salt = randomBytes(KDF_DEFAULTS.saltBytes);
  const kek = await deriveKek(PASSWORD, salt, FAST_KDF);
  const seedEnv = aesGcmEncrypt(Buffer.from(hexSeed, 'utf8'), kek);
  const mnemonicEnv = aesGcmEncrypt(Buffer.from('unused in session path', 'utf8'), kek);
  const toFields = (e: typeof seedEnv) => ({
    iv: e.iv.toString('hex'),
    ciphertext: e.ciphertext.toString('hex'),
    tag: e.tag.toString('hex'),
  });
  const encrypted: EncryptedSeed = {
    version: SEED_FILE_VERSION,
    address,
    kdf: FAST_KDF,
    salt: salt.toString('hex'),
    seed: toFields(seedEnv),
    mnemonic: toFields(mnemonicEnv),
    createdAt: 0,
  };
  return { encrypted, hexSeed, address };
}

test('unlock opens a session and withSeed yields the stored hex seed', async () => {
  const { encrypted, hexSeed, address } = await makeFixture();
  const session = new SignerSession(() => {});

  assert.equal(session.unlocked, false, 'starts locked');
  await session.unlock(encrypted, 60_000, { password: PASSWORD }, 0);
  assert.equal(session.unlocked, true);
  assert.equal(session.address, address);

  const seen = session.withSeed((s) => s, 1);
  assert.equal(seen, hexSeed, 'withSeed must expose exactly the decrypted hex seed');
});

test('unlock with a wrong password fails authentication, not silently', async () => {
  const { encrypted } = await makeFixture();
  const session = new SignerSession(() => {});
  await assert.rejects(
    () => session.unlock(encrypted, 60_000, { password: 'wrong-password' }, 0),
    AeadAuthError,
    'a wrong password must throw AeadAuthError',
  );
  assert.equal(session.unlocked, false, 'a failed unlock must leave the session locked');
});

test('lock() drops the session and withSeed throws when locked', async () => {
  const { encrypted } = await makeFixture();
  const session = new SignerSession(() => {});
  await session.unlock(encrypted, 60_000, { password: PASSWORD }, 0);

  session.lock();
  assert.equal(session.unlocked, false);
  assert.equal(session.address, null);
  assert.throws(() => session.withSeed((s) => s, 1), /locked/, 'withSeed must refuse when locked');
});

test('the autolock timer fires onAutoLock and locks the session', async (t) => {
  const { encrypted } = await makeFixture();
  let autoLockFired = 0;
  const session = new SignerSession(() => {
    autoLockFired += 1;
  });

  t.mock.timers.enable({ apis: ['setTimeout'] });
  await session.unlock(encrypted, 1_000, { password: PASSWORD }, 0);
  assert.equal(session.unlocked, true);

  t.mock.timers.tick(1_000);
  assert.equal(autoLockFired, 1, 'autolock callback must fire once');
  assert.equal(session.unlocked, false, 'autolock must lock the session');
});
