/**
 * End-to-end gas passthrough: build -> confirm summary -> sign -> decode.
 *
 * The three pieces are tested separately elsewhere. What this pins down is that
 * they agree: the gas limit a dApp asked for is the gas limit main builds, the
 * gas limit the trusted confirm window displays, AND the gas limit encoded in
 * the raw transaction the signer produces. A drift between any two of those
 * would mean the user approved a fee that is not the fee being signed.
 *
 * The RPC is mocked (endpoints pinned via env before the module import, as in
 * rpc.gas.test.ts); the signing is REAL, with a freshly generated wallet, and
 * the raw tx is decoded here with a minimal RLP reader, independent of the
 * library that produced it.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env['QRL_RPC_URL'] = 'https://primary.example/api/qrl-rpc/testnet';
process.env['QRL_RPC_URL_SECONDARY'] = 'https://secondary.example/api/qrl-rpc/testnet';

const rpc = await import('../src/main/rpc');
const { EXPECTED_CHAIN_ID, EXPECTED_GENESIS_HASH } = await import('../src/main/config');
const { recallBuild, clearBuildRecords } = await import('../src/main/buildRecords');
const { summariseSignatureRequest } = await import('../src/main/confirmSummary');
const { deriveSeedFromMnemonic, generateMnemonic, signTransaction } =
  await import('../src/signer/signing');

const realFetch = globalThis.fetch;

/** 100,000 estimate -> 120,000 buffered, under a 30,000,000 block ceiling. */
const ESTIMATE_HEX = '0x186a0';
const BLOCK_GAS_LIMIT_HEX = '0x1c9c380';
/** The live devnet fee market: 7 wei base fee, 2.5 gwei suggested tip. */
const BASE_FEE_HEX = '0x7';
const SUGGESTED_TIP_HEX = '0x9502f900';

beforeEach(() => {
  clearBuildRecords();
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    const { method, params } = JSON.parse(String(init?.body)) as {
      method: string;
      params: unknown[];
    };
    const result = ((): unknown => {
      switch (method) {
        case 'qrl_getBlockByNumber':
          return params[0] === '0x0'
            ? { hash: EXPECTED_GENESIS_HASH }
            : { gasLimit: BLOCK_GAS_LIMIT_HEX, baseFeePerGas: BASE_FEE_HEX };
        case 'qrl_getTransactionCount':
          return '0x7';
        case 'qrl_maxPriorityFeePerGas':
          return SUGGESTED_TIP_HEX;
        case 'qrl_chainId':
          return `0x${EXPECTED_CHAIN_ID.toString(16)}`;
        case 'qrl_estimateGas':
          return ESTIMATE_HEX;
        default:
          return '0x0';
      }
    })();
    return Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result })));
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------------------
// Minimal RLP reader, enough for the head of a type-2 envelope
// ---------------------------------------------------------------------------

/** Read one RLP item at `at`, returning its payload bytes and the next offset. */
function readItem(buf: Uint8Array, at: number): { payload: Uint8Array; next: number } {
  const prefix = buf[at];
  assert.ok(prefix !== undefined, 'truncated RLP');
  if (prefix <= 0x7f) return { payload: buf.subarray(at, at + 1), next: at + 1 };
  if (prefix <= 0xb7) {
    const len = prefix - 0x80;
    return { payload: buf.subarray(at + 1, at + 1 + len), next: at + 1 + len };
  }
  if (prefix <= 0xbf) {
    const lenOfLen = prefix - 0xb7;
    const len = Number(bytesToBigInt(buf.subarray(at + 1, at + 1 + lenOfLen)));
    return {
      payload: buf.subarray(at + 1 + lenOfLen, at + 1 + lenOfLen + len),
      next: at + 1 + lenOfLen + len,
    };
  }
  // A list: return the body so the caller can walk its items.
  if (prefix <= 0xf7) {
    const len = prefix - 0xc0;
    return { payload: buf.subarray(at + 1, at + 1 + len), next: at + 1 + len };
  }
  const lenOfLen = prefix - 0xf7;
  const len = Number(bytesToBigInt(buf.subarray(at + 1, at + 1 + lenOfLen)));
  return {
    payload: buf.subarray(at + 1 + lenOfLen, at + 1 + lenOfLen + len),
    next: at + 1 + lenOfLen + len,
  };
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function hexToBytes(hex: string): Uint8Array {
  const body = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i += 1)
    out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Decode the signed fields of a type-2 (EIP-1559) envelope:
 * `0x02 || rlp([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, ...])`.
 */
function decodeType2Head(rawTx: string): {
  chainId: bigint;
  nonce: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  gasLimit: bigint;
} {
  const bytes = hexToBytes(rawTx);
  assert.equal(bytes[0], 0x02, 'expected a type-2 envelope');
  const body = readItem(bytes, 1).payload;
  const values: bigint[] = [];
  let at = 0;
  for (let i = 0; i < 5; i += 1) {
    const { payload, next } = readItem(body, at);
    values.push(bytesToBigInt(payload));
    at = next;
  }
  const [chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit] = values as [
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
  ];
  return { chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit };
}

/** Pull the value of one aligned `Label:   value` detail row. */
function detailRow(detail: string, label: string): string {
  const line = detail.split('\n').find((l) => l.startsWith(label));
  assert.ok(line, `expected a "${label}" row in:\n${detail}`);
  return line.slice(label.length).trim();
}

// ---------------------------------------------------------------------------

test('a dApp gas limit survives build, display and signing byte for byte', async () => {
  const { hexSeed, address } = deriveSeedFromMnemonic(generateMnemonic());

  const tx = await rpc.buildTransaction({
    from: address,
    to: address,
    value: '0',
    feeLevel: 'medium',
    data: '0xad4c2381',
    gas: '350000',
  });

  // 1. The builder honoured the request over its own 120,000 buffered estimate.
  assert.equal(tx.gas, '350000');
  assert.deepEqual(recallBuild(tx), { estimatedGas: '120000', requestedGas: '350000' });

  // 2. The confirm window states that limit, attributes it, and prices it.
  const request = { kind: 'transaction', tx } as const;
  const { message, detail } = summariseSignatureRequest(request, { build: recallBuild(tx) });
  assert.equal(detailRow(detail, 'Gas limit:'), '350000 (set by the dApp; wallet estimate 120000)');
  const maxFee = BigInt(tx.gas) * BigInt(tx.maxFeePerGas);
  const displayedMaxFee = detailRow(detail, 'Max fee:').split(' (')[0];
  // Fee cap 2 * 7 wei + 3.75 gwei (2.5 gwei suggested tip at medium).
  assert.equal(tx.maxFeePerGas, '3750000014');
  assert.equal(tx.maxPriorityFeePerGas, '3750000000');
  assert.equal(displayedMaxFee, '0.0013125000049 Quanta');
  assert.equal(maxFee, 1_312_500_004_900_000n, 'displayed fee equals gas limit x fee cap');
  assert.equal(message, 'Send 0 Quanta? Max cost 0.0013125000049 Quanta.');

  // 3. The raw transaction the signer produced carries exactly those numbers.
  const signed = await signTransaction(hexSeed, tx, EXPECTED_CHAIN_ID);
  assert.ok(signed.rawTransaction, 'signer must return a raw transaction');
  const decoded = decodeType2Head(signed.rawTransaction);
  assert.equal(decoded.gasLimit, 350_000n, 'signed gas limit equals the displayed Gas limit');
  assert.equal(
    decoded.maxFeePerGas,
    BigInt(tx.maxFeePerGas),
    'signed fee cap equals the cap in the displayed Max fee',
  );
  assert.equal(
    decoded.maxPriorityFeePerGas,
    BigInt(tx.maxPriorityFeePerGas),
    'signed tip equals the displayed priority fee',
  );
  assert.equal(
    decoded.gasLimit * decoded.maxFeePerGas,
    maxFee,
    'the worst case signed equals the worst case shown',
  );
  assert.equal(decoded.nonce, 7n);
  assert.equal(decoded.chainId, BigInt(EXPECTED_CHAIN_ID));
});

test('without a dApp limit the same chain holds on the wallet estimate', async () => {
  const { hexSeed, address } = deriveSeedFromMnemonic(generateMnemonic());

  const tx = await rpc.buildTransaction({
    from: address,
    to: address,
    value: '0',
    feeLevel: 'medium',
    data: '0xad4c2381',
  });
  assert.equal(tx.gas, '120000', 'the 1.2x buffered estimate');

  const { detail } = summariseSignatureRequest(
    { kind: 'transaction', tx },
    { build: recallBuild(tx) },
  );
  assert.equal(detailRow(detail, 'Gas limit:'), "120000 (this wallet's estimate)");

  const signed = await signTransaction(hexSeed, tx, EXPECTED_CHAIN_ID);
  assert.equal(decodeType2Head(signed.rawTransaction).gasLimit, 120_000n);
});
