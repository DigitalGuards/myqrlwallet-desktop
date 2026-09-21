import { toChecksumAddress } from '@theqrl/wallet.js';

/**
 * QIP-55 case rule (wallet.js semantics): uniform-case bodies are valid;
 * a mixed-case body must match the SHAKE-256 checksum exactly.
 * toChecksumAddress throws on a mixed-case body with a bad checksum and
 * accepts every other well-formed spelling, so a single call decides.
 */
export function hasValidQrlAddressCase(value: string): boolean {
  const body = value.slice(1);
  const lower = body.toLowerCase();
  if (body === lower || body === body.toUpperCase()) return true;
  try {
    return toChecksumAddress(value) === value;
  } catch {
    return false;
  }
}

/** Reject a mixed-case address whose casing does not match its checksum. */
export function assertValidQrlAddressCase(value: string, label: string): void {
  if (!hasValidQrlAddressCase(value)) {
    throw new Error(`${label} address has an invalid QIP-55 checksum casing`);
  }
}
