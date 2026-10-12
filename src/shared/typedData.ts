/** Pure typed-data parsing and resource limits shared by both IPC boundaries.
 * The codec contract follows the web wallet and Connect SDK. No crypto runs here.
 */
import { SCHEME } from './constants';
import { isQrlAddress } from './address';
import { isArray, isRecord } from './guards';

export type TypedDataSchemeVersion = typeof SCHEME.TAG_TYPED | typeof SCHEME.TAG_TYPED_V2;

export const TYPED_DATA_LIMITS = Object.freeze({
  maxTypes: 32,
  maxFieldsPerType: 32,
  maxTotalFields: 256,
  maxTypeGraphDepth: 12,
  maxArrayNesting: 12,
  maxArrayLength: 256,
  maxEncodedValues: 2048,
  maxDynamicBytes: 16 * 1024,
  maxIdentifierLength: 64,
  maxFieldTypeLength: 128,
});

export type FieldType = string;
export interface TypedField {
  name: string;
  type: FieldType;
}
export type StructDef = readonly TypedField[];
export type TypeMap = Record<string, StructDef>;
export type Domain = Record<string, unknown>;
export type Message = Record<string, unknown>;

export interface TypedDataPayload {
  types: TypeMap;
  primaryType: string;
  domain: Domain;
  message: Message;
}

export type AtomicKind =
  | { kind: 'address' | 'bool' | 'string' | 'bytes' }
  | { kind: 'uintN' | 'intN'; width: number }
  | { kind: 'bytesN'; width: number }
  | { kind: 'array'; inner: FieldType; size?: number }
  | { kind: 'ref'; name: string };

function isMessageObject(value: unknown): value is Message {
  return isRecord(value);
}

function hasExactOwnKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function isTypedField(value: unknown): value is TypedField {
  return (
    isMessageObject(value) &&
    hasExactOwnKeys(value, ['name', 'type']) &&
    typeof value['name'] === 'string' &&
    typeof value['type'] === 'string'
  );
}

function isTypeMap(value: unknown): value is TypeMap {
  if (!isMessageObject(value)) return false;
  let typeCount = 0;
  for (const name in value) {
    if (!Object.prototype.hasOwnProperty.call(value, name)) continue;
    typeCount += 1;
    if (typeCount > TYPED_DATA_LIMITS.maxTypes) return false;
    const definition = value[name];
    if (!isArray(definition) || definition.length > TYPED_DATA_LIMITS.maxFieldsPerType) {
      return false;
    }
    for (const field of definition) {
      if (!isTypedField(field)) return false;
    }
  }
  return true;
}

function parsePayload(payload: unknown): TypedDataPayload {
  if (!isMessageObject(payload)) throw new Error('invalid typed data payload');
  if (!hasExactOwnKeys(payload, ['types', 'primaryType', 'domain', 'message'])) {
    throw new Error('typed data payload contains unknown top-level fields');
  }
  const types = payload['types'];
  const primaryType = payload['primaryType'];
  const domain = payload['domain'];
  const message = payload['message'];
  if (!isTypeMap(types)) throw new Error('typed data types must be a struct map');
  if (typeof primaryType !== 'string') {
    throw new Error('typed data primaryType must be a string');
  }
  if (!isMessageObject(domain)) throw new Error('typed data domain must be an object');
  if (!isMessageObject(message)) throw new Error('typed data message must be an object');
  return { types, primaryType, domain, message };
}

const ATOMIC_RE = /^(?:(address|bool|string|bytes)|(u?int)(\d+)|bytes(\d+)|(.+?)\[(\d*)\])$/;
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function assertIdentifier(value: string, label: string): void {
  if (
    !IDENTIFIER_RE.test(value) ||
    value.length > TYPED_DATA_LIMITS.maxIdentifierLength ||
    UNSAFE_OBJECT_KEYS.has(value)
  ) {
    throw new Error(`invalid ${label}: ${value}`);
  }
}

export function parseFieldType(type: FieldType, types: TypeMap, depth = 0): AtomicKind {
  if (depth > TYPED_DATA_LIMITS.maxArrayNesting) {
    throw new Error(`type nesting too deep: ${type}`);
  }
  if (type.length > TYPED_DATA_LIMITS.maxFieldTypeLength) {
    throw new Error(`field type too long: ${type}`);
  }
  const m = ATOMIC_RE.exec(type);
  if (m) {
    const [, atomic, intKind, intWidthStr, bytesWidthStr, innerType, sizeStr] = m;
    if (atomic === 'address' || atomic === 'bool' || atomic === 'string' || atomic === 'bytes') {
      return { kind: atomic };
    }
    if (intKind) {
      const width = Number(intWidthStr);
      if (!Number.isInteger(width) || width < 8 || width > 256 || width % 8 !== 0) {
        throw new Error(`invalid int width: ${type}`);
      }
      return { kind: intKind === 'uint' ? 'uintN' : 'intN', width };
    }
    if (bytesWidthStr) {
      const width = Number(bytesWidthStr);
      if (!Number.isInteger(width) || width < 1 || width > 32) {
        throw new Error(`invalid bytesN width: ${type}`);
      }
      return { kind: 'bytesN', width };
    }
    if (innerType !== undefined) {
      parseFieldType(innerType, types, depth + 1);
      if (sizeStr) {
        const size = Number(sizeStr);
        if (!Number.isSafeInteger(size) || size <= 0 || size > TYPED_DATA_LIMITS.maxArrayLength) {
          throw new Error(`invalid array size: ${type}`);
        }
        return { kind: 'array', inner: innerType, size };
      }
      return { kind: 'array', inner: innerType };
    }
  }
  if (Object.prototype.hasOwnProperty.call(types, type)) {
    return { kind: 'ref', name: type };
  }
  throw new Error(`unknown type: ${type}`);
}

function isReservedAtomicTypeName(name: string): boolean {
  if (/^(?:address|bool|string|bytes)$/.test(name)) return true;
  const intMatch = /^(?:u?int)(\d+)$/.exec(name);
  if (intMatch) {
    const width = Number(intMatch[1]);
    return Number.isInteger(width) && width >= 8 && width <= 256 && width % 8 === 0;
  }
  const bytesMatch = /^bytes(\d+)$/.exec(name);
  if (bytesMatch) {
    const width = Number(bytesMatch[1]);
    return Number.isInteger(width) && width >= 1 && width <= 32;
  }
  return false;
}

function baseTypeName(type: FieldType): string {
  return type.replace(/(\[\d*\])+$/, '');
}

function collectDependencies(primary: string, types: TypeMap): Set<string> {
  if (!Object.prototype.hasOwnProperty.call(types, primary)) {
    throw new Error(`unknown primary type: ${primary}`);
  }
  const visited = new Set<string>();
  const visit = (name: string, path: string[]): void => {
    if (path.length > TYPED_DATA_LIMITS.maxTypeGraphDepth) {
      throw new Error(`type graph nesting too deep: ${[...path, name].join(' -> ')}`);
    }
    if (path.includes(name)) {
      throw new Error(`cyclic type reference: ${[...path, name].join(' -> ')}`);
    }
    if (visited.has(name)) return;
    visited.add(name);
    const fields = types[name];
    if (!fields) throw new Error(`unknown type: ${name}`);
    for (const f of fields) {
      const base = baseTypeName(f.type);
      if (Object.prototype.hasOwnProperty.call(types, base)) {
        visit(base, [...path, name]);
      }
      // Validate every dimension, including struct arrays such as Party[0].
      parseFieldType(f.type, types);
    }
  };
  visit(primary, []);
  return visited;
}

function validateTypeMap(types: TypeMap): void {
  const entries = Object.entries(types);
  if (entries.length === 0 || entries.length > TYPED_DATA_LIMITS.maxTypes) {
    throw new Error(`typed data must contain 1-${TYPED_DATA_LIMITS.maxTypes} struct types`);
  }
  let totalFields = 0;
  for (const [name, def] of entries) {
    assertIdentifier(name, 'struct name');
    if (name !== 'QRLDomain' && isReservedAtomicTypeName(name)) {
      throw new Error(`struct name is reserved by an atomic type: ${name}`);
    }
    if (!isArray(def) || def.length === 0 || def.length > TYPED_DATA_LIMITS.maxFieldsPerType) {
      throw new Error(`empty or invalid struct: ${name}`);
    }
    totalFields += def.length;
    if (totalFields > TYPED_DATA_LIMITS.maxTotalFields) {
      throw new Error('typed data contains too many fields');
    }
    const seen = new Set<string>();
    for (const f of def) {
      if (typeof f.name !== 'string' || !f.name) {
        throw new Error(`bad field in ${name}`);
      }
      if (typeof f.type !== 'string' || !f.type) {
        throw new Error(`bad field type in ${name}.${f.name}`);
      }
      assertIdentifier(f.name, `field name in ${name}`);
      if (seen.has(f.name)) {
        throw new Error(`duplicate field "${f.name}" in ${name}`);
      }
      seen.add(f.name);
    }
  }
}

/**
 * Canonical `encodeType` form: `Primary(t n,...)Referenced1(...)Referenced2(...)`
 * with primary first and referenced structs sorted alphabetically by name.
 *
 * This only emits structs reachable from `primary`. Unused-declaration
 * rejection is a payload-level concern (the union of reachable sets across
 * QRLDomain + primaryType) and is checked when parsing a payload.
 */
export function encodeType(primary: string, types: TypeMap): string {
  validateTypeMap(types);
  const deps = collectDependencies(primary, types);
  const others = [...deps].filter((n) => n !== primary).sort();
  return [primary, ...others]
    .map((name) => {
      const fields = types[name];
      if (!fields) {
        // Every dependency is collected from `types`, so this is unreachable;
        // fail closed if a definition is missing.
        throw new Error(`encodeType: missing type definition for ${name}`);
      }
      const inner = fields.map((f) => `${f.type} ${f.name}`).join(',');
      return `${name}(${inner})`;
    })
    .join('');
}

export function parseIntValue(v: unknown, typeLabel: string): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'string') {
    if (v.length > 80) throw new Error(`${typeLabel} value is too long`);
    if (/^-?0x[0-9a-fA-F]+$/i.test(v)) {
      // BigInt() throws on a "-0x.." literal, so split the sign off first.
      const isNegative = v.startsWith('-');
      const abs = BigInt(isNegative ? v.slice(1) : v);
      return isNegative ? -abs : abs;
    }
    if (!/^-?(0|[1-9]\d*)$/.test(v)) {
      throw new Error(`invalid ${typeLabel} string: ${v}`);
    }
    return BigInt(v);
  }
  if (typeof v === 'number') {
    if (!Number.isInteger(v) || !Number.isSafeInteger(v)) {
      throw new Error(`unsafe ${typeLabel} number: ${v}, pass as string`);
    }
    return BigInt(v);
  }
  throw new Error(`unsupported ${typeLabel} value: ${typeof v}`);
}

const RESERVED_DOMAIN_FIELDS: Record<string, string> = {
  name: 'string',
  version: 'string',
  chainId: 'uint256',
  verifyingContract: 'address',
  salt: 'bytes32',
};

function validateDomainTypes(types: TypeMap): void {
  const def = types['QRLDomain'];
  if (!def) throw new Error('QRLDomain type is required');
  let hasName = false;
  for (const f of def) {
    const expected = RESERVED_DOMAIN_FIELDS[f.name];
    if (!expected) {
      throw new Error(
        `QRLDomain field "${f.name}" not in reserved set ` +
          `(name, version, chainId, verifyingContract, salt)`,
      );
    }
    if (f.type !== expected) {
      throw new Error(`QRLDomain field "${f.name}" must be type "${expected}", got "${f.type}"`);
    }
    if (f.name === 'name') hasName = true;
  }
  if (!hasName) throw new Error('QRLDomain.name is required');
}

function validatePayloadReachability(primary: string, types: TypeMap): void {
  const reachable = new Set<string>();
  for (const root of ['QRLDomain', primary]) {
    for (const t of collectDependencies(root, types)) reachable.add(t);
  }
  for (const k of Object.keys(types)) {
    if (!reachable.has(k)) throw new Error(`unused referenced type: ${k}`);
  }
}

function parseAndValidatePayload(payload: unknown): TypedDataPayload {
  const parsed = parsePayload(payload);
  validateTypeMap(parsed.types);
  assertIdentifier(parsed.primaryType, 'primary type');
  if (parsed.primaryType === 'QRLDomain') {
    throw new Error('QRLDomain cannot be the primary type');
  }
  validateDomainTypes(parsed.types);
  validatePayloadReachability(parsed.primaryType, parsed.types);
  return parsed;
}

/**
 * v2 when any struct has an `address` field, including address arrays.
 * Payload validation rejects types unreachable from QRLDomain and the
 * primary type, so for a payload this is "an address type is reachable".
 * The scheme belongs to the whole payload: an address-free struct hashes
 * with 64-byte slots when the domain or another struct has an address.
 */
function schemeVersionForTypes(types: TypeMap): TypedDataSchemeVersion {
  for (const fields of Object.values(types)) {
    if (fields.some((f) => baseTypeName(f.type) === 'address')) {
      return SCHEME.TAG_TYPED_V2;
    }
  }
  return SCHEME.TAG_TYPED;
}

/**
 * The scheme a payload is signed and verified under. It follows from the
 * payload's types alone, so wallet and verifier agree without negotiating.
 */
export function typedDataSchemeVersion(payload: unknown): TypedDataSchemeVersion {
  return schemeVersionForTypes(parseAndValidatePayload(payload).types);
}

export function assertIntegerRange(value: bigint, width: number, signed: boolean): void {
  const limit = 1n << BigInt(signed ? width - 1 : width);
  if (value < (signed ? -limit : 0n) || value >= limit) {
    throw new Error(`${signed ? 'int' : 'uint'}${width} out of range`);
  }
}

interface ValueBudget {
  remaining: number;
}

function consumeValue(budget: ValueBudget): void {
  if (--budget.remaining < 0) throw new Error('typed data contains too many encoded values');
}

/** Used by the signer to check address checksum casing before hashing. */
type AddressCheck = (address: string) => void;

function validateStruct(
  primary: string,
  data: unknown,
  types: TypeMap,
  budget: ValueBudget,
  depth: number,
  addressCheck?: AddressCheck,
): void {
  consumeValue(budget);
  if (!isRecord(data)) throw new Error(`struct field expects object: ${primary}`);
  const fields = types[primary];
  if (!fields) throw new Error(`unknown struct: ${primary}`);
  const expected = new Set(fields.map((f) => f.name));
  for (const key in data) {
    if (Object.hasOwn(data, key) && !expected.has(key)) {
      throw new Error(`unknown field in ${primary}`);
    }
  }
  for (const field of fields) {
    if (!Object.hasOwn(data, field.name)) throw new Error(`missing field ${primary}.${field.name}`);
    validateValue(field.type, data[field.name], types, budget, depth + 1, addressCheck);
  }
}

function validateValue(
  type: string,
  value: unknown,
  types: TypeMap,
  budget: ValueBudget,
  depth: number,
  addressCheck?: AddressCheck,
): void {
  if (depth > TYPED_DATA_LIMITS.maxTypeGraphDepth + TYPED_DATA_LIMITS.maxArrayNesting) {
    throw new Error('value nesting too deep');
  }
  consumeValue(budget);
  const parsed = parseFieldType(type, types);
  switch (parsed.kind) {
    case 'ref':
      validateStruct(parsed.name, value, types, budget, depth + 1, addressCheck);
      return;
    case 'array':
      if (!isArray(value)) throw new Error('array field expects array');
      if (value.length > TYPED_DATA_LIMITS.maxArrayLength) {
        throw new Error('array exceeds length limit');
      }
      if (parsed.size !== undefined && parsed.size !== value.length) {
        throw new Error(`fixed array ${type} requires length ${parsed.size}`);
      }
      for (const item of value) {
        validateValue(parsed.inner, item, types, budget, depth + 1, addressCheck);
      }
      return;
    case 'address':
      if (!isQrlAddress(value)) throw new Error('invalid Q-address');
      addressCheck?.(value);
      return;
    case 'bool':
      if (typeof value !== 'boolean') throw new Error('bool field expects boolean');
      return;
    case 'string':
      if (typeof value !== 'string') throw new Error('string field expects string');
      if (
        value.length > TYPED_DATA_LIMITS.maxDynamicBytes ||
        new TextEncoder().encode(value).length > TYPED_DATA_LIMITS.maxDynamicBytes
      ) {
        throw new Error('string field exceeds typed data byte limit');
      }
      return;
    case 'bytes':
    case 'bytesN': {
      if (typeof value !== 'string') throw new Error('bytes field expects 0x-hex string');
      const maxBytes = parsed.kind === 'bytesN' ? parsed.width : TYPED_DATA_LIMITS.maxDynamicBytes;
      if (value.length > maxBytes * 2 + 2)
        throw new Error('bytes field exceeds typed data byte limit');
      if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) throw new Error('invalid hex bytes');
      if (parsed.kind === 'bytesN' && value.length !== parsed.width * 2 + 2) {
        throw new Error(`bytes${parsed.width} requires ${parsed.width} bytes`);
      }
      return;
    }
    case 'uintN':
    case 'intN':
      assertIntegerRange(parseIntValue(value, type), parsed.width, parsed.kind === 'intN');
  }
}

/** All structure, value and resource checks complete before the signer hashes. */
export function validateTypedDataPayload(
  payload: unknown,
  addressCheck?: AddressCheck,
): TypedDataPayload {
  const parsed = parseAndValidatePayload(payload);
  const budget = { remaining: TYPED_DATA_LIMITS.maxEncodedValues };
  validateStruct('QRLDomain', parsed.domain, parsed.types, budget, 0, addressCheck);
  validateStruct(parsed.primaryType, parsed.message, parsed.types, budget, 0, addressCheck);
  return parsed;
}
