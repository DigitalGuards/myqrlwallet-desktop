/**
 * Argon2id key-encryption-key derivation, via the Rust-backed @node-rs/argon2.
 *
 * This is the load-bearing control: even if every OS app-binding layer is
 * defeated by same-context malware, the attacker still only has an
 * Argon2id-hardened blob. We derive RAW key bytes (hashRaw), NOT a PHC string,
 * because we need a deterministic 32-byte KEK that the same password + stored
 * salt + stored params re-produces exactly.
 *
 * The single most dangerous mistake here is omitting the salt: @node-rs/argon2
 * auto-generates a random salt when none is supplied, which would make the KEK
 * unreproducible and brick the wallet. We ALWAYS pass the caller's stored salt.
 */
import { hashRaw, type Algorithm, type Options, type Version } from '@node-rs/argon2';
import type { KdfParams } from '../shared/constants';
import { AEAD } from '../shared/constants';

/**
 * Derive a 256-bit KEK. `password` is taken as a string (the only place a
 * password exists as a JS string in this process); it is converted to bytes by
 * the binding. `salt` and `params` come from the stored EncryptedSeed so the
 * derivation is deterministic across unlocks.
 */
export async function deriveKek(
  password: string,
  salt: Buffer,
  params: KdfParams,
): Promise<Buffer> {
  if (salt.length < 8) {
    throw new Error('argon2 salt too short');
  }
  const options: Options = {
    // KdfParams stores the enum values as plain numbers so they serialize into
    // the on-disk envelope; cast back to the binding's enum types.
    algorithm: params.algorithm as Algorithm,
    version: params.version as Version,
    salt,
    outputLen: params.outputLen,
    memoryCost: params.memoryCost,
    timeCost: params.timeCost,
    parallelism: params.parallelism,
  };
  const kek = await hashRaw(password, options);
  if (kek.length !== AEAD.KEY_BYTES) {
    throw new Error(`derived KEK length ${kek.length} != ${AEAD.KEY_BYTES}`);
  }
  // hashRaw returns a Node Buffer; hand it back as-is so the caller can wipe it.
  return kek;
}
