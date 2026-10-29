/** Public QRL address derivation and QIP-55 checksum validation. */
import { shake256 } from '@noble/hashes/sha3.js';
import { isQrlAddress, QRL_ADDRESS_HEX_LENGTH } from './address';
import { MLDSA87 } from './constants';

/** Derive a public address from the fixed ML-DSA-87 descriptor and public key. */
export function publicKeyToQrlAddress(publicKey: Uint8Array): string {
  if (publicKey.length !== MLDSA87.PUBLIC_KEY_BYTES) {
    throw new Error('Public key has the wrong length');
  }
  const descriptor = Uint8Array.from([0x01, 0x00, 0x00]);
  const input = new Uint8Array(descriptor.length + publicKey.length);
  input.set(descriptor);
  input.set(publicKey, descriptor.length);
  const hash = shake256(input, { dkLen: QRL_ADDRESS_HEX_LENGTH / 2 });
  return `Q${Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** Format a public address with wallet.js-compatible QIP-55 checksum casing. */
export function toChecksumQrlAddress(value: string): string {
  if (!isQrlAddress(value)) throw new Error('Invalid QRL address');
  const lower = value.slice(1).toLowerCase();
  const hash = shake256(new TextEncoder().encode(lower), { dkLen: QRL_ADDRESS_HEX_LENGTH / 2 });
  let result = 'Q';
  for (let i = 0; i < lower.length; i++) {
    const byte = hash[Math.floor(i / 2)];
    if (byte === undefined) throw new Error('Incomplete QIP-55 checksum');
    const nibble = i % 2 === 0 ? byte >> 4 : byte & 15;
    const char = lower.charAt(i);
    result += nibble >= 8 ? char.toUpperCase() : char;
  }
  return result;
}

/** Uniform-case bodies pass; mixed-case bodies must match wallet.js QIP-55. */
export function hasValidQrlAddressCase(value: string): boolean {
  if (!isQrlAddress(value)) return false;
  const body = value.slice(1);
  return (
    body === body.toLowerCase() ||
    body === body.toUpperCase() ||
    value === toChecksumQrlAddress(value)
  );
}

export function assertValidQrlAddressCase(value: string, label: string): void {
  if (!hasValidQrlAddressCase(value)) {
    throw new Error(`${label} address has an invalid QIP-55 checksum casing`);
  }
}
