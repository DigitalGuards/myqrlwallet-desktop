/**
 * IPC boundary-validation test. Security invariant #4 (CLAUDE.md): every IPC
 * handler zod-PARSES its argument before acting, so malformed / oversized /
 * extra-keyed payloads from a (possibly compromised) renderer are rejected at
 * the boundary, never reaching crypto code. These are pure schema checks, so
 * they run under `node --test --import tsx` with no Electron.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BuildTransactionRequestSchema,
  CreateWalletRequestSchema,
  GetBalanceRequestSchema,
  ImportWalletRequestSchema,
  PasswordSchema,
  RemoveWalletRequestSchema,
  SendRawTransactionRequestSchema,
  SetActiveWalletRequestSchema,
  SignatureRequestSchema,
  UnlockRequestSchema,
  UnsignedTransactionSchema,
} from '../src/shared/schemas';

const ADDR = 'Q' + 'a'.repeat(40);
const ADDR2 = 'Q' + 'b'.repeat(40);

const validTx = {
  from: ADDR,
  to: ADDR2,
  value: '1000',
  nonce: 0,
  gas: '21000',
  maxFeePerGas: '2000000000',
  maxPriorityFeePerGas: '1000000000',
  chainId: 1337,
  type: '0x2' as const,
};

test('GetBalanceRequest accepts a valid Q-address and rejects junk + extra keys', () => {
  assert.equal(GetBalanceRequestSchema.safeParse({ address: ADDR }).success, true);
  assert.equal(GetBalanceRequestSchema.safeParse({ address: '0xdeadbeef' }).success, false);
  assert.equal(GetBalanceRequestSchema.safeParse({ address: ADDR + 'ff' }).success, false);
  // .strict(): an unexpected extra field is rejected, not ignored.
  assert.equal(GetBalanceRequestSchema.safeParse({ address: ADDR, evil: 1 }).success, false);
});

test('BuildTransactionRequest defaults feeLevel, bounds data, and rejects bad levels', () => {
  const ok = BuildTransactionRequestSchema.safeParse({ from: ADDR, to: ADDR2, value: '10' });
  assert.equal(ok.success, true);
  assert.equal(ok.success && ok.data.feeLevel, 'medium', 'feeLevel defaults to medium');

  assert.equal(
    BuildTransactionRequestSchema.safeParse({ from: ADDR, to: ADDR2, value: '10', feeLevel: 'ludicrous' }).success,
    false,
    'an unknown fee level is rejected',
  );
  assert.equal(
    BuildTransactionRequestSchema.safeParse({ from: ADDR, to: ADDR2, value: 'not-a-number' }).success,
    false,
    'value must be a decimal string',
  );
  const hugeData = '0x' + 'a'.repeat(2 * 128 * 1024 + 2);
  assert.equal(
    BuildTransactionRequestSchema.safeParse({ from: ADDR, to: ADDR2, value: '10', data: hugeData }).success,
    false,
    'oversized calldata is rejected',
  );
});

test('UnsignedTransaction enforces a complete type-2 shape', () => {
  assert.equal(UnsignedTransactionSchema.safeParse(validTx).success, true);
  assert.equal(
    UnsignedTransactionSchema.safeParse({ ...validTx, nonce: -1 }).success,
    false,
    'negative nonce rejected',
  );
  const { maxFeePerGas: _omit, ...missingFee } = validTx;
  assert.equal(
    UnsignedTransactionSchema.safeParse(missingFee).success,
    false,
    'missing maxFeePerGas rejected',
  );
  assert.equal(
    UnsignedTransactionSchema.safeParse({ ...validTx, chainId: 0 }).success,
    false,
    'chainId must be positive',
  );
});

test('SignatureRequest validates each arm and bounds payload size', () => {
  assert.equal(
    SignatureRequestSchema.safeParse({ kind: 'transaction', tx: validTx }).success,
    true,
  );
  assert.equal(
    SignatureRequestSchema.safeParse({ kind: 'message', messageHex: '0xdeadbeef' }).success,
    true,
  );
  assert.equal(
    SignatureRequestSchema.safeParse({ kind: 'nonsense', tx: validTx }).success,
    false,
    'unknown kind rejected by the discriminated union',
  );
  const hugeMessage = '0x' + 'a'.repeat(2 * 64 * 1024 + 2);
  assert.equal(
    SignatureRequestSchema.safeParse({ kind: 'message', messageHex: hugeMessage }).success,
    false,
    'oversized message rejected',
  );
  const hugePayload = { kind: 'typedData', payload: { big: 'a'.repeat(70 * 1024) } };
  assert.equal(
    SignatureRequestSchema.safeParse(hugePayload).success,
    false,
    'oversized typedData payload rejected',
  );
});

test('SendRawTransactionRequest requires 0x-prefixed hex', () => {
  assert.equal(SendRawTransactionRequestSchema.safeParse({ rawTx: '0xabcdef' }).success, true);
  assert.equal(SendRawTransactionRequestSchema.safeParse({ rawTx: 'abcdef' }).success, false);
  assert.equal(SendRawTransactionRequestSchema.safeParse({ rawTx: '0xzz' }).success, false);
});

test('Password + provisioning schemas bound their inputs', () => {
  assert.equal(PasswordSchema.safeParse('').success, false, 'empty password rejected');
  assert.equal(PasswordSchema.safeParse('a'.repeat(1025)).success, false, 'over-long password rejected');
  assert.equal(PasswordSchema.safeParse('a decent password').success, true);

  const create = CreateWalletRequestSchema.safeParse({ password: 'pw' });
  assert.equal(create.success, true);
  assert.equal(create.success && create.data.useKeychain, false, 'useKeychain defaults to false');
});

test('ImportWalletRequest takes exactly one of mnemonic or hexSeed', () => {
  const hexSeed = '0x' + 'ab'.repeat(51);
  assert.equal(
    ImportWalletRequestSchema.safeParse({ mnemonic: 'word '.repeat(31) + 'word', password: 'pw' })
      .success,
    true,
    'mnemonic-only accepted',
  );
  assert.equal(
    ImportWalletRequestSchema.safeParse({ hexSeed, password: 'pw' }).success,
    true,
    'hexSeed-only accepted',
  );
  assert.equal(
    ImportWalletRequestSchema.safeParse({ password: 'pw' }).success,
    false,
    'neither source rejected',
  );
  assert.equal(
    ImportWalletRequestSchema.safeParse({ mnemonic: 'words', hexSeed, password: 'pw' }).success,
    false,
    'both sources rejected',
  );
  assert.equal(
    ImportWalletRequestSchema.safeParse({ hexSeed: '0x' + 'ab'.repeat(50), password: 'pw' })
      .success,
    false,
    'wrong-length hexSeed rejected',
  );
  assert.equal(
    ImportWalletRequestSchema.safeParse({ hexSeed: 'zz'.repeat(51), password: 'pw' }).success,
    false,
    'non-hex hexSeed rejected',
  );
});

test('Unlock / removeWallet / setActiveWallet multi-wallet arguments', () => {
  assert.equal(UnlockRequestSchema.safeParse({}).success, true, 'bare unlock (keychain) accepted');
  assert.equal(
    UnlockRequestSchema.safeParse({ password: 'pw', address: ADDR }).success,
    true,
    'unlock with target address accepted',
  );
  assert.equal(
    UnlockRequestSchema.safeParse({ address: 'not-an-address' }).success,
    false,
    'malformed unlock address rejected',
  );

  assert.equal(
    RemoveWalletRequestSchema.safeParse(undefined).success,
    true,
    'argless removeWallet (active wallet) accepted for back-compat',
  );
  assert.equal(RemoveWalletRequestSchema.safeParse({ address: ADDR }).success, true);
  assert.equal(
    RemoveWalletRequestSchema.safeParse({ address: ADDR, extra: 1 }).success,
    false,
    'extra keys rejected',
  );

  assert.equal(SetActiveWalletRequestSchema.safeParse({ address: ADDR }).success, true);
  assert.equal(
    SetActiveWalletRequestSchema.safeParse({}).success,
    false,
    'setActiveWallet requires an address',
  );
});

test('SignatureRequest rejects arm-mixing + extra keys and accepts empty payloads', () => {
  // Strict discriminated union: a message arm carrying a tx field is rejected.
  assert.equal(
    SignatureRequestSchema.safeParse({ kind: 'message', messageHex: '0xab', tx: validTx }).success,
    false,
    'arm-mixing rejected',
  );
  // .strict(): an extra key on the transaction arm is rejected.
  assert.equal(
    SignatureRequestSchema.safeParse({ kind: 'transaction', tx: validTx, foo: 1 }).success,
    false,
    'extra key rejected',
  );
  // An empty message and an empty typedData payload are both valid.
  assert.equal(SignatureRequestSchema.safeParse({ kind: 'message', messageHex: '0x' }).success, true);
  assert.equal(SignatureRequestSchema.safeParse({ kind: 'typedData', payload: {} }).success, true);
  // The message bound is on the TOTAL string length (incl. the 0x prefix).
  const maxLen = 2 * 64 * 1024;
  assert.equal(
    SignatureRequestSchema.safeParse({ kind: 'message', messageHex: '0x' + 'a'.repeat(maxLen - 2) }).success,
    true,
    'message at the length bound is accepted',
  );
  assert.equal(
    SignatureRequestSchema.safeParse({ kind: 'message', messageHex: '0x' + 'a'.repeat(maxLen) }).success,
    false,
    'message over the length bound is rejected',
  );
});

test('Decimal + hex + address boundary values', () => {
  // Zero transfer and leading-zero decimals are valid amounts.
  assert.equal(BuildTransactionRequestSchema.safeParse({ from: ADDR, to: ADDR2, value: '0' }).success, true);
  assert.equal(BuildTransactionRequestSchema.safeParse({ from: ADDR, to: ADDR2, value: '0001' }).success, true);
  // Mixed-case Q-address is accepted (EIP-55 casing is tolerated by the schema).
  assert.equal(
    GetBalanceRequestSchema.safeParse({ address: 'Q' + 'a'.repeat(20) + 'A'.repeat(20) }).success,
    true,
    'mixed-case address accepted',
  );
  // Calldata: bare even-length hex ok; odd-length (incl. 0x parity) rejected.
  assert.equal(
    BuildTransactionRequestSchema.safeParse({ from: ADDR, to: ADDR2, value: '1', data: 'abcd' }).success,
    true,
    'bare even hex calldata accepted',
  );
  assert.equal(
    BuildTransactionRequestSchema.safeParse({ from: ADDR, to: ADDR2, value: '1', data: '0xabc' }).success,
    false,
    'odd-length hex calldata rejected',
  );
});
