/**
 * Host-side check of the unsigned transaction preimage before it reaches the
 * device.
 *
 * The QRL v2.0 app signs `0x02 || rlp([chain_id, nonce, tip, fee_cap, gas, to,
 * value, data, access_list, descriptor, extra_params])` (doc/TRANSACTION.md in
 * theQRL/ledger-app-qrl-v2). This walker applies the app decoder's structural
 * rules (type byte, eleven fields of the right kinds, canonical lengths, an
 * empty or 64-byte recipient, the ML-DSA-87 descriptor, empty extra_params),
 * so a malformed preimage is refused before it costs a device round trip. The
 * device still bounds the numeric fields itself. It also reports whether the
 * device will treat the transaction as a blind sign (non-empty data or access
 * list).
 */
import { LedgerError } from './errors';

const TX_TYPE_DYNAMIC_FEE = 0x02;
const FIELD_COUNT = 11;
const TO_INDEX = 5;
const DATA_INDEX = 7;
const ACCESS_LIST_INDEX = 8;
const DESCRIPTOR_INDEX = 9;
const EXTRA_PARAMS_INDEX = 10;
const ADDRESS_BYTES = 64;
const MLDSA87_DESCRIPTOR = [0x01, 0x00, 0x00];

export interface PreimageInfo {
  /** Byte length of the whole preimage, type byte included. */
  length: number;
  /** Non-empty data or access list: the device requires Blind signing. */
  needsBlindSigning: boolean;
  /** Empty `to`: a contract deployment. */
  contractCreation: boolean;
}

interface RlpItem {
  isList: boolean;
  start: number;
  length: number;
  end: number;
}

function fail(reason: string): LedgerError {
  return new LedgerError('invalid-preimage', `Invalid transaction preimage: ${reason}`);
}

function readLength(bytes: Uint8Array, offset: number, size: number): number {
  if (size === 0 || offset + size > bytes.length || bytes[offset] === 0) {
    throw fail('bad length prefix');
  }
  let n = 0;
  for (let i = 0; i < size; i++) n = n * 256 + (bytes[offset + i] ?? 0);
  if (n < 56) throw fail('non-canonical length');
  return n;
}

function readItem(bytes: Uint8Array, offset: number, limit: number): RlpItem {
  const prefix = bytes[offset];
  if (prefix === undefined || offset >= limit) throw fail('truncated item');
  let item: RlpItem;
  if (prefix < 0x80) {
    item = { isList: false, start: offset, length: 1, end: offset + 1 };
  } else if (prefix <= 0xb7) {
    const length = prefix - 0x80;
    if (length === 1 && (bytes[offset + 1] ?? 0) < 0x80) throw fail('non-canonical byte');
    item = { isList: false, start: offset + 1, length, end: offset + 1 + length };
  } else if (prefix <= 0xbf) {
    const size = prefix - 0xb7;
    const length = readLength(bytes, offset + 1, size);
    item = { isList: false, start: offset + 1 + size, length, end: offset + 1 + size + length };
  } else if (prefix <= 0xf7) {
    const length = prefix - 0xc0;
    item = { isList: true, start: offset + 1, length, end: offset + 1 + length };
  } else {
    const size = prefix - 0xf7;
    const length = readLength(bytes, offset + 1, size);
    item = { isList: true, start: offset + 1 + size, length, end: offset + 1 + size + length };
  }
  if (item.end > limit) throw fail('item overruns its list');
  return item;
}

export function inspectPreimage(preimage: Uint8Array): PreimageInfo {
  if (preimage[0] !== TX_TYPE_DYNAMIC_FEE) throw fail('not a type 2 transaction');
  const list = readItem(preimage, 1, preimage.length);
  if (!list.isList) throw fail('payload is not a list');
  if (list.end !== preimage.length) throw fail('trailing bytes after the list');

  const fields: RlpItem[] = [];
  let offset = list.start;
  while (offset < list.end) {
    const item = readItem(preimage, offset, list.end);
    fields.push(item);
    offset = item.end;
  }
  if (fields.length !== FIELD_COUNT) throw fail(`expected ${FIELD_COUNT} fields`);

  fields.forEach((field, i) => {
    if (field.isList !== (i === ACCESS_LIST_INDEX)) throw fail(`field ${i} has the wrong kind`);
  });
  const to = fields[TO_INDEX];
  const data = fields[DATA_INDEX];
  const accessList = fields[ACCESS_LIST_INDEX];
  const descriptor = fields[DESCRIPTOR_INDEX];
  const extraParams = fields[EXTRA_PARAMS_INDEX];
  if (!to || !data || !accessList || !descriptor || !extraParams) throw fail('missing field');

  if (to.length !== 0 && to.length !== ADDRESS_BYTES) throw fail('recipient is not 64 bytes');
  const descriptorBytes = preimage.subarray(descriptor.start, descriptor.end);
  if (
    descriptorBytes.length !== MLDSA87_DESCRIPTOR.length ||
    MLDSA87_DESCRIPTOR.some((b, i) => descriptorBytes[i] !== b)
  ) {
    throw fail('descriptor is not ML-DSA-87 (01 00 00)');
  }
  if (extraParams.length !== 0) throw fail('extra_params must be empty');

  return {
    length: preimage.length,
    needsBlindSigning: data.length > 0 || accessList.length > 0,
    contractCreation: to.length === 0,
  };
}
