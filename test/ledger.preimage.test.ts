import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LedgerError, inspectPreimage } from '../src/ledger';
import { concatBytes, fromHex, toHex } from '../src/ledger/bytes';
import { expectedString, loadFixture } from './ledgerFixtures';

// Minimal RLP encoder for building preimage variants.
function intBytes(value: bigint): Uint8Array {
  if (value === 0n) return new Uint8Array(0);
  let hex = value.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  return fromHex(hex);
}
function lengthPrefix(base: number, length: number): Uint8Array {
  if (length <= 55) return Uint8Array.from([base + length]);
  const len = intBytes(BigInt(length));
  return concatBytes(Uint8Array.from([base + 55 + len.length]), len);
}
function str(bytes: Uint8Array): Uint8Array {
  if (bytes.length === 1 && (bytes[0] ?? 0) < 0x80) return bytes;
  return concatBytes(lengthPrefix(0x80, bytes.length), bytes);
}
function list(items: Uint8Array[]): Uint8Array {
  const payload = concatBytes(...items);
  return concatBytes(lengthPrefix(0xc0, payload.length), payload);
}

interface Fields {
  chainId: bigint;
  nonce: bigint;
  tip: bigint;
  feeCap: bigint;
  gas: bigint;
  to: Uint8Array;
  value: bigint;
  data: Uint8Array;
}

function preimage(
  f: Fields,
  overrides: Partial<Record<number, Uint8Array>> = {},
  type = 2,
): Uint8Array {
  const items = [
    str(intBytes(f.chainId)),
    str(intBytes(f.nonce)),
    str(intBytes(f.tip)),
    str(intBytes(f.feeCap)),
    str(intBytes(f.gas)),
    str(f.to),
    str(intBytes(f.value)),
    str(f.data),
    list([]),
    str(Uint8Array.from([1, 0, 0])),
    str(new Uint8Array(0)),
  ].map((item, i) => overrides[i] ?? item);
  return concatBytes(Uint8Array.from([type]), list(items));
}

const live = loadFixture('theqrl-nanosp-sign-live.json');
const liveFields = live.fields as Record<string, string>;
const BASE: Fields = {
  chainId: BigInt(live.chainId as string),
  nonce: BigInt(liveFields.nonce ?? '0'),
  tip: BigInt(liveFields.tip ?? '0'),
  feeCap: BigInt(liveFields.maxFee ?? '0'),
  gas: BigInt(liveFields.gas ?? '0'),
  to: fromHex((live.to as string).slice(1)),
  value: BigInt(liveFields.value ?? '0'),
  data: new Uint8Array(0),
};

function invalid(bytes: Uint8Array, label: string): void {
  assert.throws(
    () => inspectPreimage(bytes),
    (error: unknown) => error instanceof LedgerError && error.code === 'invalid-preimage',
    label,
  );
}

test('the recorded @theqrl/web3 preimage matches a hand-encoded one byte for byte', () => {
  assert.equal(toHex(preimage(BASE)), expectedString(live, 'preimage'));
});

test('a native transfer is a clear sign', () => {
  assert.deepEqual(inspectPreimage(fromHex(expectedString(live, 'preimage'))), {
    length: 103,
    needsBlindSigning: false,
    contractCreation: false,
  });
});

test('calldata or an access list makes a blind sign', () => {
  const blind = loadFixture('theqrl-nanosp-sign-blind.json');
  assert.equal(inspectPreimage(fromHex(expectedString(blind, 'preimage'))).needsBlindSigning, true);
  const withAccessList = preimage(BASE, { 8: list([list([str(new Uint8Array(64)), list([])])]) });
  assert.equal(inspectPreimage(withAccessList).needsBlindSigning, true);
});

test('an empty recipient is a contract creation', () => {
  const info = inspectPreimage(
    preimage({ ...BASE, to: new Uint8Array(0), data: Uint8Array.from([0x60]) }),
  );
  assert.equal(info.contractCreation, true);
  assert.equal(info.needsBlindSigning, true);
});

test('structural violations the app would refuse are rejected on the host', () => {
  invalid(preimage(BASE, {}, 1), 'type 1');
  invalid(preimage({ ...BASE, to: new Uint8Array(20) }), '20-byte recipient');
  invalid(preimage(BASE, { 9: str(Uint8Array.from([2, 0, 0])) }), 'descriptor');
  invalid(preimage(BASE, { 10: str(Uint8Array.from([1])) }), 'extra_params');
  invalid(preimage(BASE, { 7: list([]) }), 'data as a list');
  invalid(preimage(BASE, { 8: str(new Uint8Array(0)) }), 'access list as a string');
  invalid(preimage(BASE, { 1: Uint8Array.from([0x81, 0x05]) }), 'non-canonical byte');
  invalid(concatBytes(preimage(BASE), Uint8Array.from([0])), 'trailing byte');
  const ten = concatBytes(
    Uint8Array.from([2]),
    list(Array.from({ length: 10 }, () => str(new Uint8Array(0)))),
  );
  invalid(ten, 'ten fields');
  invalid(Uint8Array.from([2, 0xf8, 0x00]), 'long list with a short length');
  invalid(new Uint8Array(0), 'empty');
});
