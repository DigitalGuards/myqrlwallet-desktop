/** QRL-SIGN-TYPED v1/v2 SHAKE256 codec, byte-compatible with the wallet and SDK.
 * Validation completes before hashing; key operations remain in signing.ts.
 */
import { shake256 } from '@noble/hashes/sha3.js';
import { MLDSA87, SCHEME } from '../shared/constants';
import { isArray, isRecord } from '../shared/guards';
import {
  assertIntegerRange,
  encodeType,
  parseFieldType,
  parseIntValue,
  typedDataSchemeVersion,
  validateTypedDataPayload,
  type TypeMap,
  type Message,
  type FieldType,
  type TypedDataSchemeVersion,
} from '../shared/typedData';
import { assertValidQrlAddressCase } from './addressCase';

const DIGEST_LEN = MLDSA87.DIGEST_BYTES;
const SLOT_BYTES = { [SCHEME.TAG_TYPED]: 32, [SCHEME.TAG_TYPED_V2]: 64 } as const;

export function typedDataSchemeTag(scheme: TypedDataSchemeVersion): Uint8Array {
  return new TextEncoder().encode(scheme);
}

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex.slice(2), 'hex'));
}

function concatBytesArr(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export function typeHash(primary: string, types: TypeMap): Uint8Array {
  return shake256(new TextEncoder().encode(encodeType(primary, types)), { dkLen: DIGEST_LEN });
}

function parseQAddress(addr: string, slot: number): Uint8Array {
  assertValidQrlAddressCase(addr, 'typed-data');
  const bytes = hexToBytes('0x' + addr.slice(1).toLowerCase());
  if (bytes.length > slot) {
    throw new Error('qrl_signTypedData v1 does not support QIP-55 address fields');
  }
  return bytes;
}

function padLeft(bytes: Uint8Array, slot: number): Uint8Array {
  if (bytes.length > slot) throw new Error(`cannot pad: bytes > ${slot}`);
  const out = new Uint8Array(slot);
  out.set(bytes, slot - bytes.length);
  return out;
}

function padRight(bytes: Uint8Array, slot: number): Uint8Array {
  if (bytes.length > slot) throw new Error(`cannot pad: bytes > ${slot}`);
  const out = new Uint8Array(slot);
  out.set(bytes, 0);
  return out;
}

function bigIntToSlot(value: bigint, width: number, signed: boolean, slot: number): Uint8Array {
  assertIntegerRange(value, width, signed);
  // Represent in two's complement over the full scheme slot.
  const slotBits = BigInt(slot * 8);
  const slotMask = (1n << slotBits) - 1n;
  const repr = value < 0n ? (value + (1n << slotBits)) & slotMask : value;
  const out = new Uint8Array(slot);
  let v = repr;
  for (let i = slot - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function encodeField(type: FieldType, value: unknown, types: TypeMap, slot: number): Uint8Array {
  const parsed = parseFieldType(type, types);

  switch (parsed.kind) {
    case 'ref':
      if (!isRecord(value)) {
        throw new Error(`struct field expects object: ${type}`);
      }
      return hashStruct(parsed.name, value, types, slot);

    case 'address':
      if (typeof value !== 'string') {
        throw new Error(`address field expects string: ${typeof value}`);
      }
      return padLeft(parseQAddress(value, slot), slot);

    case 'bool':
      if (typeof value !== 'boolean') {
        throw new Error(`bool field expects boolean: ${typeof value}`);
      }
      return padLeft(new Uint8Array([value ? 1 : 0]), slot);

    case 'string': {
      if (typeof value !== 'string') {
        throw new Error(`string field expects string: ${typeof value}`);
      }
      const encoded = new TextEncoder().encode(value);
      return shake256(encoded, { dkLen: DIGEST_LEN });
    }

    case 'bytes':
      if (typeof value !== 'string') {
        throw new Error(`bytes field expects 0x-hex string: ${typeof value}`);
      }
      return shake256(hexToBytes(value), { dkLen: DIGEST_LEN });

    case 'uintN':
      return bigIntToSlot(parseIntValue(value, `uint${parsed.width}`), parsed.width, false, slot);

    case 'intN':
      return bigIntToSlot(parseIntValue(value, `int${parsed.width}`), parsed.width, true, slot);

    case 'bytesN': {
      if (typeof value !== 'string') {
        throw new Error(`bytes${parsed.width} expects 0x-hex string: ${typeof value}`);
      }
      if (value.length !== parsed.width * 2 + 2) {
        throw new Error(`bytes${parsed.width} requires ${parsed.width} bytes`);
      }
      const raw = hexToBytes(value);
      if (raw.length !== parsed.width) {
        throw new Error(`bytes${parsed.width} requires ${parsed.width} bytes, got ${raw.length}`);
      }
      return padRight(raw, slot);
    }

    case 'array': {
      if (!isArray(value)) {
        throw new Error(`array field expects array: ${typeof value}`);
      }
      const chunks = value.map((v) => encodeField(parsed.inner, v, types, slot));
      return shake256(concatBytesArr(chunks), { dkLen: DIGEST_LEN });
    }
  }
}

function hashStruct(primary: string, data: Message, types: TypeMap, slot: number): Uint8Array {
  const fields = types[primary];
  if (!fields) throw new Error(`unknown struct: ${primary}`);
  const parts: Uint8Array[] = [typeHash(primary, types)];
  for (const f of fields) {
    if (!Object.prototype.hasOwnProperty.call(data, f.name)) {
      throw new Error(`missing field ${primary}.${f.name}`);
    }
    parts.push(encodeField(f.type, data[f.name], types, slot));
  }
  return shake256(concatBytesArr(parts), { dkLen: DIGEST_LEN });
}

/** Hash only after both domain and message have passed every input bound. */
export function computeTypedDataDigest(payload: unknown): Uint8Array {
  const parsed = validateTypedDataPayload(payload);
  // Check checksum casing inside the crypto fence, after all resource limits.
  validateTypedDataPayload(parsed, (address) => assertValidQrlAddressCase(address, 'typed-data'));
  const scheme = typedDataSchemeVersion(parsed);
  const slot = SLOT_BYTES[scheme];
  const domainHash = hashStruct('QRLDomain', parsed.domain, parsed.types, slot);
  const messageHash = hashStruct(parsed.primaryType, parsed.message, parsed.types, slot);
  return shake256(concatBytesArr([typedDataSchemeTag(scheme), domainHash, messageHash]), {
    dkLen: DIGEST_LEN,
  });
}
