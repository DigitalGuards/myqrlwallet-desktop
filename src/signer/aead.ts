/**
 * AES-256-GCM authenticated encryption of the seed blob, via Node's native
 * `node:crypto` (OpenSSL). GCM is authenticated: a wrong KEK or any tampering
 * of the ciphertext throws on decrypt rather than returning garbage plaintext
 * (the failure mode that made the old AES-CBC wallet format unsafe).
 *
 * Only the signer process ever calls this; the KEK is never passed to main or
 * the renderer.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AEAD } from '../shared/constants';

export interface AeadEnvelope {
  iv: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

/** Encrypt UTF-8 `plaintext` under a 32-byte KEK. Fresh random nonce each call. */
export function aesGcmEncrypt(plaintext: Buffer, kek: Buffer): AeadEnvelope {
  if (kek.length !== AEAD.KEY_BYTES) {
    throw new Error('kek must be 32 bytes');
  }
  const iv = randomBytes(AEAD.IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', kek, iv, { authTagLength: AEAD.TAG_BYTES });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv, ciphertext, tag };
}

/**
 * Decrypt and authenticate. Throws `AeadAuthError` on a wrong KEK or tampered
 * ciphertext/tag so the caller can map it to "invalid password" without
 * leaking which check failed.
 */
export class AeadAuthError extends Error {
  constructor() {
    super('decryption failed: wrong key or corrupted data');
    this.name = 'AeadAuthError';
  }
}

export function aesGcmDecrypt(env: AeadEnvelope, kek: Buffer): Buffer {
  if (kek.length !== AEAD.KEY_BYTES) {
    throw new Error('kek must be 32 bytes');
  }
  const decipher = createDecipheriv('aes-256-gcm', kek, env.iv, { authTagLength: AEAD.TAG_BYTES });
  decipher.setAuthTag(env.tag);
  try {
    return Buffer.concat([decipher.update(env.ciphertext), decipher.final()]);
  } catch {
    throw new AeadAuthError();
  }
}
