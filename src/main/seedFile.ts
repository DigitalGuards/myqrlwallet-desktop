/**
 * Persistence of the encrypted-seed envelope. Main owns disk; the signer never
 * touches the filesystem. The file contains only ciphertext + non-secret KDF
 * parameters (salt, iv, tag, argon2 cost) - never plaintext key material - so
 * at rest it is an Argon2id-hardened AES-256-GCM blob.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { EncryptedSeed } from '../shared/protocol';

function seedPath(): string {
  return path.join(app.getPath('userData'), 'wallet', 'seed.json');
}

export async function hasSeed(): Promise<boolean> {
  try {
    await fs.access(seedPath());
    return true;
  } catch {
    return false;
  }
}

export async function readSeed(): Promise<EncryptedSeed | null> {
  try {
    const raw = await fs.readFile(seedPath(), 'utf8');
    return JSON.parse(raw) as EncryptedSeed;
  } catch {
    return null;
  }
}

export async function writeSeed(enc: EncryptedSeed): Promise<void> {
  const p = seedPath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  // 0600: owner read/write only.
  await fs.writeFile(p, JSON.stringify(enc, null, 2), { mode: 0o600 });
}

/**
 * Delete the encrypted seed from disk (the destructive "remove wallet" path).
 * Idempotent: succeeds whether or not the file exists. The blob is ciphertext,
 * so unlinking it is sufficient to make the wallet unrecoverable without the
 * recovery phrase.
 */
export async function deleteSeed(): Promise<void> {
  await fs.rm(seedPath(), { force: true });
}
