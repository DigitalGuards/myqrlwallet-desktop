/**
 * Persistence of the encrypted-seed envelope. Main owns disk; the signer never
 * touches the filesystem. The file contains only ciphertext + non-secret KDF
 * parameters (salt, iv, tag, argon2 cost) - never plaintext key material - so
 * at rest it is an Argon2id-hardened AES-256-GCM blob.
 *
 * Durability contract: writes are ATOMIC (write to a temp file, fsync, rename)
 * so a crash mid-write can never leave a truncated seed.json, and hasSeed() is
 * defined as "readSeed() would succeed" so an unreadable file cannot strand the
 * app on an unlock screen that can never unlock. A file that exists but does
 * not parse as an EncryptedSeed is quarantined (renamed aside), never silently
 * overwritten, so whatever bytes survived remain available for manual recovery.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { EncryptedSeed } from '../shared/protocol';

function seedPath(): string {
  return path.join(app.getPath('userData'), 'wallet', 'seed.json');
}

// Monotonic per-process sequence for unique temp-file names (see writeSeed).
let tmpSeq = 0;
function nextTmpSeq(): number {
  return tmpSeq++;
}

function isAeadFields(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['iv'] === 'string' &&
    typeof o['ciphertext'] === 'string' &&
    typeof o['tag'] === 'string'
  );
}

/** Structural check so a JSON-valid but wrong-shaped file counts as corrupt
 * here instead of surfacing as a confusing decrypt error in the signer. */
function isEncryptedSeed(v: unknown): v is EncryptedSeed {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['version'] === 'string' &&
    typeof o['address'] === 'string' &&
    typeof o['salt'] === 'string' &&
    typeof o['kdf'] === 'object' &&
    o['kdf'] !== null &&
    isAeadFields(o['seed']) &&
    isAeadFields(o['mnemonic'])
  );
}

export async function hasSeed(): Promise<boolean> {
  return (await readSeed()) !== null;
}

export async function readSeed(): Promise<EncryptedSeed | null> {
  try {
    const raw = await fs.readFile(seedPath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return isEncryptedSeed(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** True if a seed file exists on disk but cannot be read as an EncryptedSeed. */
async function seedFileIsCorrupt(): Promise<boolean> {
  try {
    await fs.access(seedPath());
  } catch {
    return false; // absent, not corrupt
  }
  return (await readSeed()) === null;
}

export async function writeSeed(enc: EncryptedSeed): Promise<void> {
  const p = seedPath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  // Never silently destroy an existing-but-unreadable file: quarantine it so
  // its bytes stay recoverable. (An intact wallet is protected by the explicit
  // "a wallet already exists" checks upstream, not here.)
  if (await seedFileIsCorrupt()) {
    const quarantine = `${p}.corrupt-${Date.now()}`;
    await fs.rename(p, quarantine);
    console.error(`writeSeed: quarantined unreadable seed file to ${quarantine}`);
  }
  // Atomic replace: write + fsync a UNIQUE temp file, then rename over the
  // target. The unique suffix (pid + a per-process counter) keeps two
  // concurrent writeSeed calls from clobbering a shared `${p}.tmp` and renaming
  // a half-written file into place; the single-instance lock guarantees one
  // process, so pid+counter is collision-free. The final rename is atomic.
  const tmp = `${p}.${process.pid}.${nextTmpSeq()}.tmp`;
  const handle = await fs.open(tmp, 'w', 0o600); // 0600: owner read/write only
  try {
    await handle.writeFile(JSON.stringify(enc, null, 2), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, p);
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
