/** Public QIP-55 checksum validation shared by main and the isolated signer. */
import { shake256 } from '@noble/hashes/sha3.js';
import { isQrlAddress, QRL_ADDRESS_HEX_LENGTH } from './address';

/** Uniform-case bodies pass; mixed-case bodies must match wallet.js QIP-55. */
export function hasValidQrlAddressCase(value: string): boolean {
  if (!isQrlAddress(value)) return false;
  const body = value.slice(1);
  const lower = body.toLowerCase();
  if (body === lower || body === body.toUpperCase()) return true;
  const hash = shake256(new TextEncoder().encode(lower), { dkLen: QRL_ADDRESS_HEX_LENGTH / 2 });
  for (let i = 0; i < body.length; i++) {
    const byte = hash[Math.floor(i / 2)];
    if (byte === undefined) return false;
    const nibble = i % 2 === 0 ? byte >> 4 : byte & 15;
    const char = lower.charAt(i);
    if (body.charAt(i) !== (nibble >= 8 ? char.toUpperCase() : char)) return false;
  }
  return true;
}

export function assertValidQrlAddressCase(value: string, label: string): void {
  if (!hasValidQrlAddressCase(value)) {
    throw new Error(`${label} address has an invalid QIP-55 checksum casing`);
  }
}
