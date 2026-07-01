/**
 * Persistence of the encrypted-seed envelopes. Main owns disk; the signer never
 * touches the filesystem. Every file contains only ciphertext + non-secret KDF
 * parameters (salt, iv, tag, argon2 cost) - never plaintext key material - so
 * at rest each wallet is an Argon2id-hardened AES-256-GCM blob.
 *
 * MULTI-WALLET LAYOUT (v2):
 *   userData/wallet/seeds/<address-lowercase>.json   one envelope per wallet
 *   userData/wallet/active.json                      { address } pointer
 * The legacy single-wallet file (userData/wallet/seed.json) is migrated into
 * this layout once at boot by migrateLegacySeed().
 *
 * Durability contract: writes are ATOMIC (write to a temp file, fsync, rename)
 * so a crash mid-write can never leave a truncated envelope, and presence
 * checks are defined as "the read would succeed" so an unreadable file cannot
 * strand the app on an unlock screen that can never unlock. A file that exists
 * but does not parse as an EncryptedSeed is quarantined (renamed aside), never
 * silently overwritten, so whatever bytes survived remain available for manual
 * recovery.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { EncryptedSeed } from '../shared/protocol';

const ADDRESS_RE = /^Q[0-9a-fA-F]{40}$/;

function walletDir(): string {
  return path.join(app.getPath('userData'), 'wallet');
}

function seedsDir(): string {
  return path.join(walletDir(), 'seeds');
}

function legacySeedPath(): string {
  return path.join(walletDir(), 'seed.json');
}

function activePath(): string {
  return path.join(walletDir(), 'active.json');
}

/**
 * Per-wallet envelope path. The address doubles as the file name, so it is
 * validated against the strict address shape before ever touching a path
 * (defense against a tampered envelope smuggling path segments), and
 * LOWERCASED so two EIP-55 casings of the same account cannot become two
 * files on a case-sensitive filesystem (or collide unpredictably on a
 * case-insensitive one).
 */
function seedPathFor(address: string): string {
  if (!ADDRESS_RE.test(address)) throw new Error('invalid wallet address');
  return path.join(seedsDir(), `${address.toLowerCase()}.json`);
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
    ADDRESS_RE.test(o['address'] as string) &&
    typeof o['salt'] === 'string' &&
    typeof o['kdf'] === 'object' &&
    o['kdf'] !== null &&
    isAeadFields(o['seed']) &&
    isAeadFields(o['mnemonic'])
  );
}

async function readEnvelopeFile(p: string): Promise<EncryptedSeed | null> {
  try {
    const raw = await fs.readFile(p, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return isEncryptedSeed(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Atomic replace: write + fsync a 0600 temp file, then rename over target.
 * The temp name is UNIQUE per process (pid + a monotonic counter) so two
 * concurrent atomicWrite calls to the same path cannot clobber a shared
 * `${p}.tmp` and rename a half-written file into place; the final rename is
 * atomic. The single-instance lock guarantees one process, so pid+counter is
 * collision-free. */
async function atomicWrite(p: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${nextTmpSeq()}.tmp`;
  const handle = await fs.open(tmp, 'w', 0o600); // 0600: owner read/write only
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, p);
}

// ---- wallet listing / lookup ------------------------------------------------

/** Every readable wallet envelope on disk, ordered by creation time. */
export async function listSeeds(): Promise<EncryptedSeed[]> {
  let names: string[];
  try {
    names = await fs.readdir(seedsDir());
  } catch {
    return [];
  }
  // Read every envelope concurrently rather than serially.
  const jsonNames = names.filter((name) => name.endsWith('.json'));
  const read = await Promise.all(
    jsonNames.map((name) => readEnvelopeFile(path.join(seedsDir(), name))),
  );
  const seeds = read.filter((s): s is EncryptedSeed => s !== null);
  // Fall back to 0 for a missing createdAt so the comparator never returns NaN
  // (a legacy/hand-edited envelope could lack it), keeping the sort stable.
  return seeds.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}

export async function readSeedByAddress(address: string): Promise<EncryptedSeed | null> {
  if (!ADDRESS_RE.test(address)) return null;
  return readEnvelopeFile(seedPathFor(address));
}

export async function hasAnySeed(): Promise<boolean> {
  return (await listSeeds()).length > 0;
}

// ---- active-wallet pointer ----------------------------------------------------

/**
 * The active wallet's address. Self-healing: a pointer at a missing/unreadable
 * envelope falls back to the oldest wallet on disk (and is rewritten), so a
 * stale pointer can never dead-end the unlock flow.
 */
export async function getActiveAddress(): Promise<string | null> {
  let pointed: string | null = null;
  try {
    const raw = await fs.readFile(activePath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const a = (parsed as { address?: unknown } | null)?.address;
    if (typeof a === 'string' && ADDRESS_RE.test(a)) pointed = a;
  } catch {
    /* absent or unreadable: fall through to self-heal */
  }
  if (pointed && (await readSeedByAddress(pointed))) return pointed;
  const first = (await listSeeds())[0] ?? null;
  await setActiveAddress(first ? first.address : null);
  return first ? first.address : null;
}

export async function setActiveAddress(address: string | null): Promise<void> {
  if (address === null) {
    await fs.rm(activePath(), { force: true });
    return;
  }
  if (!ADDRESS_RE.test(address)) throw new Error('invalid wallet address');
  await atomicWrite(activePath(), JSON.stringify({ address }));
}

/** The active wallet's envelope (null when no wallet exists). */
export async function readActiveSeed(): Promise<EncryptedSeed | null> {
  const address = await getActiveAddress();
  return address ? readSeedByAddress(address) : null;
}

// ---- write / delete -----------------------------------------------------------

export async function writeSeed(enc: EncryptedSeed): Promise<void> {
  const p = seedPathFor(enc.address);
  // Never silently destroy an existing-but-unreadable file: quarantine it so
  // its bytes stay recoverable. (An intact wallet is protected by the explicit
  // duplicate-address checks upstream, not here.)
  let existsUnreadable = false;
  try {
    await fs.access(p);
    existsUnreadable = (await readEnvelopeFile(p)) === null;
  } catch {
    /* absent */
  }
  if (existsUnreadable) {
    const quarantine = `${p}.corrupt-${Date.now()}`;
    await fs.rename(p, quarantine);
    console.error(`writeSeed: quarantined unreadable seed file to ${quarantine}`);
  }
  await atomicWrite(p, JSON.stringify(enc, null, 2));
}

/**
 * Delete ONE wallet's encrypted seed from disk (the destructive "remove
 * wallet" path). Idempotent: succeeds whether or not the file exists. The blob
 * is ciphertext, so unlinking it is sufficient to make the wallet
 * unrecoverable without the recovery phrase.
 */
export async function deleteSeed(address: string): Promise<void> {
  if (!ADDRESS_RE.test(address)) return;
  await fs.rm(seedPathFor(address), { force: true });
  // Heal the pointer if it referenced the removed wallet.
  await getActiveAddress();
}

// ---- legacy migration -----------------------------------------------------------

/**
 * One-shot boot migration from the single-wallet layout (wallet/seed.json) to
 * the per-address store. A readable legacy envelope moves into seeds/ and
 * becomes the active wallet (unless one is already set); an unreadable legacy
 * file is left in place untouched (its bytes may still matter to the user).
 */
export async function migrateLegacySeed(): Promise<void> {
  const legacy = await readEnvelopeFile(legacySeedPath());
  if (!legacy) return;
  if (!(await readSeedByAddress(legacy.address))) {
    await writeSeed(legacy);
  }
  if (!(await hasActivePointer())) {
    await setActiveAddress(legacy.address);
  }
  await fs.rm(legacySeedPath(), { force: true });
  console.log(`migrateLegacySeed: migrated ${legacy.address} to the multi-wallet store`);
}

async function hasActivePointer(): Promise<boolean> {
  try {
    await fs.access(activePath());
    return true;
  } catch {
    return false;
  }
}
