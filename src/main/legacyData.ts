/**
 * Detection of pre-v3 wallet data left behind in the OLD userData directory.
 *
 * QIP-55 moved the app onto 64-byte addresses and a separate `v3-private`
 * userData directory, so a machine that ran v1.0.x keeps its earlier encrypted
 * envelopes next to the new store. The startup notice that explains this is
 * only honest when such an envelope is actually there, hence a PRESENCE check:
 * this module stats and lists directory entries, it never opens an envelope,
 * so no ciphertext, address, or KDF parameter is read here.
 *
 * A clean install has no legacy `wallet/` directory at all. Note the bare
 * directory is not enough on its own: uninstalling the app leaves AppData in
 * place, and a v1.0.x user who removed every wallet keeps an empty `seeds/`
 * directory with nothing left to recover.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Envelope files only: atomic-write temp files (`.<pid>.<seq>.tmp`) and
 * quarantined ones (`.corrupt-<ts>`) do not end in `.json`, and `active.json`
 * lives in the wallet directory rather than in `seeds/`. */
function isEnvelopeName(name: string): boolean {
  return name.endsWith('.json');
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

/**
 * True when `legacyUserDataDir` still holds at least one wallet envelope from
 * a pre-v3 build: either the pre-multi-wallet `wallet/seed.json` or any
 * `wallet/seeds/*.json`. Never throws: an unreadable directory counts as
 * "nothing to say", because a startup notice is not worth a failed boot.
 */
export async function hasLegacyWalletData(legacyUserDataDir: string): Promise<boolean> {
  const walletDir = path.join(legacyUserDataDir, 'wallet');
  if (await isFile(path.join(walletDir, 'seed.json'))) return true;
  let names: string[];
  try {
    names = await fs.readdir(path.join(walletDir, 'seeds'));
  } catch {
    return false;
  }
  return names.some(isEnvelopeName);
}
