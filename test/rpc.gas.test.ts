/**
 * Gas policy for the transaction builder (src/main/rpc.ts buildTransaction):
 *
 * Every transfer uses qrl_estimateGas with a 1.2x buffer, including contract
 * receivers reached through empty calldata. An estimate failure stops the build.
 *
 * A dApp-requested gas limit (BuildTransactionRequest.gas) changes the rule to
 * max(request, buffered estimate), bounded above by the latest block's gas
 * limit: a too-low request cannot yield an out-of-gas transaction, a larger one
 * is honoured exactly, and an impossible one is refused.
 *
 * fetch is mocked; the RPC endpoints are pinned via env BEFORE the module
 * import (config.ts reads env at import time), and rpc.ts is loaded with a
 * dynamic import so the pin is in place first.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env['QRL_RPC_URL'] = 'https://primary.example/api/qrl-rpc/testnet';
process.env['QRL_RPC_URL_SECONDARY'] = 'https://secondary.example/api/qrl-rpc/testnet';

const rpc = await import('../src/main/rpc');
const { recallBuild, clearBuildRecords } = await import('../src/main/buildRecords');
const { EXPECTED_CHAIN_ID, EXPECTED_GENESIS_HASH } = await import('../src/main/config');

interface RecordedCall {
  method: string;
  params: unknown[];
}

let calls: RecordedCall[] = [];
let estimateResponse: { result?: string; error?: { code: number; message: string } };
/** The latest block's gasLimit the mocked node reports (30,000,000 by default).
 * A number models a non-conforming node answer; undefined omits the field. */
let latestBlockGasLimit: string | number | undefined;
/** The latest block's baseFeePerGas (7 wei by default); undefined omits it. */
let latestBaseFee: string | number | undefined;
/** When set, the node refuses the latest-block read with this JSON-RPC error. */
let latestBlockError: string | undefined;
/** The node's qrl_maxPriorityFeePerGas answer (2.5 gwei by default). */
let tipResponse: { result?: unknown; error?: { code: number; message: string } };
/** When false, the node refuses qrl_gasPrice. */
let gasPriceAvailable: boolean;

const realFetch = globalThis.fetch;

const READ_RESULTS: Record<string, string> = {
  qrl_getTransactionCount: '0x5',
  qrl_gasPrice: '0x3b9aca00', // 1 gwei
  qrl_chainId: `0x${EXPECTED_CHAIN_ID.toString(16)}`,
};

const methodsCalled = () => calls.map((c) => c.method);

beforeEach(() => {
  calls = [];
  clearBuildRecords();
  estimateResponse = { result: '0x249f0' }; // 150000
  latestBlockGasLimit = '0x1c9c380'; // 30,000,000
  latestBaseFee = '0x7';
  latestBlockError = undefined;
  tipResponse = { result: '0x9502f900' }; // 2.5 gwei
  gasPriceAvailable = true;
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    const { method, params } = JSON.parse(String(init?.body)) as RecordedCall;
    // The genesis read is the endpoint-identity probe every call makes; the
    // 'latest' read carries the base fee and the block gas limit, so record
    // that one.
    if (method === 'qrl_getBlockByNumber' && params[0] === '0x0') {
      return Promise.resolve(
        new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, result: { hash: EXPECTED_GENESIS_HASH } }),
        ),
      );
    }
    calls.push({ method, params });
    if (method === 'qrl_getBlockByNumber') {
      if (latestBlockError !== undefined) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              error: { code: -32000, message: latestBlockError },
            }),
          ),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              ...(latestBlockGasLimit === undefined ? {} : { gasLimit: latestBlockGasLimit }),
              ...(latestBaseFee === undefined ? {} : { baseFeePerGas: latestBaseFee }),
            },
          }),
        ),
      );
    }
    const payload =
      method === 'qrl_gasPrice' && !gasPriceAvailable
        ? { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'the method does not exist' } }
        : method === 'qrl_estimateGas'
          ? { jsonrpc: '2.0', id: 1, ...estimateResponse }
          : method === 'qrl_maxPriorityFeePerGas'
            ? { jsonrpc: '2.0', id: 1, ...tipResponse }
            : { jsonrpc: '2.0', id: 1, result: READ_RESULTS[method] ?? '0x0' };
    return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const REQ = {
  from: `Q${'11'.repeat(64)}`,
  to: `Q${'22'.repeat(64)}`,
  value: '1000000000000000000',
  feeLevel: 'medium' as const,
};

test('buildTransaction estimates a simple value transfer', async () => {
  estimateResponse = { result: '0x5208' }; // 21000
  const tx = await rpc.buildTransaction(REQ);
  assert.equal(tx.gas, '25200');
  const estimate = calls.find((call) => call.method === 'qrl_estimateGas');
  assert.deepEqual(estimate?.params, [
    {
      from: REQ.from,
      to: REQ.to,
      value: '0xde0b6b3a7640000',
      data: '0x',
      maxFeePerGas: '0xdf84758e', // 2 * 7 wei base fee + 3.75 gwei tip
      maxPriorityFeePerGas: '0xdf847580', // 2.5 gwei suggestion * 1.5 (medium)
    },
  ]);
});

test('buildTransaction budgets receive-handler execution with empty calldata', async () => {
  for (const data of [undefined, '0x']) {
    const tx = await rpc.buildTransaction({ ...REQ, data });
    assert.equal(tx.gas, '180000', 'contract execution needs the estimated gas');
  }
});

test('buildTransaction rejects a value transfer whose recipient cannot receive it', async () => {
  estimateResponse = { error: { code: -32000, message: 'execution reverted' } };
  await assert.rejects(rpc.buildTransaction(REQ), /execution reverted/);
});

test('buildTransaction estimates contract calls and applies the 1.2x buffer', async () => {
  const tx = await rpc.buildTransaction({ ...REQ, data: '0xad4c2381' });
  assert.equal(tx.gas, '180000', '150000 estimate * 1.2 buffer');
  assert.ok(methodsCalled().includes('qrl_estimateGas'));
});

test('buildTransaction canonicalizes bare-hex calldata to 0x form (schema admits both)', async () => {
  const tx = await rpc.buildTransaction({ ...REQ, data: 'ad4c2381' });
  assert.equal(tx.gas, '180000', 'bare hex still estimates');
  assert.equal(tx.data, '0xad4c2381', 'built tx carries the 0x form');
  const estimate = calls.find((c) => c.method === 'qrl_estimateGas');
  assert.ok(estimate, 'estimate dispatched');
  const [callParams] = estimate.params as [{ data?: string }];
  assert.equal(callParams.data, '0xad4c2381', 'estimate payload carries the 0x form');
});

test('buildTransaction surfaces an estimate rejection instead of building a doomed tx', async () => {
  estimateResponse = { error: { code: -32000, message: 'execution reverted' } };
  await assert.rejects(rpc.buildTransaction({ ...REQ, data: '0xdeadbeef' }), /execution reverted/);
});

// ---------------------------------------------------------------------------
// dApp-requested gas limit: max(request, buffered estimate), block-bounded
// ---------------------------------------------------------------------------

test('a dApp gas limit above the buffered estimate is honoured exactly', async () => {
  estimateResponse = { result: '0x186a0' }; // 100000 -> 120000 buffered
  // QuantaSwap HTLCv3 settlement asks for estimateGas + 250000.
  const tx = await rpc.buildTransaction({ ...REQ, data: '0xad4c2381', gas: '350000' });
  assert.equal(tx.gas, '350000', 'the request wins when it exceeds the estimate');
});

test('a dApp gas limit below the buffered estimate is floored by the estimate', async () => {
  estimateResponse = { result: '0x186a0' }; // 100000 -> 120000 buffered
  const tx = await rpc.buildTransaction({ ...REQ, data: '0xad4c2381', gas: '21000' });
  assert.equal(tx.gas, '120000', 'a too-low request cannot produce an out-of-gas transaction');
});

test('a dApp gas limit equal to the buffered estimate builds that exact limit', async () => {
  estimateResponse = { result: '0x186a0' }; // 100000 -> 120000 buffered
  const tx = await rpc.buildTransaction({ ...REQ, data: '0xad4c2381', gas: '120000' });
  assert.equal(tx.gas, '120000');
});

test('a dApp gas limit is still refused when the estimate itself reverts', async () => {
  estimateResponse = { error: { code: -32000, message: 'execution reverted' } };
  await assert.rejects(
    rpc.buildTransaction({ ...REQ, data: '0xad4c2381', gas: '350000' }),
    /execution reverted/,
    'a requested limit never substitutes for a successful estimate',
  );
});

test('a dApp gas limit above the block gas limit is rejected', async () => {
  estimateResponse = { result: '0x186a0' };
  latestBlockGasLimit = '0x1c9c380'; // 30,000,000
  await assert.rejects(
    rpc.buildTransaction({ ...REQ, data: '0xad4c2381', gas: '30000001' }),
    /exceeds the block gas limit 30000000/,
  );
  // The ceiling itself is allowed.
  const tx = await rpc.buildTransaction({ ...REQ, data: '0xad4c2381', gas: '30000000' });
  assert.equal(tx.gas, '30000000');
});

test('an unusable block gas limit fails the build; the ceiling is never skipped', async () => {
  estimateResponse = { result: '0x186a0' };
  latestBlockGasLimit = undefined; // node answers without a gasLimit field
  await assert.rejects(
    rpc.buildTransaction({ ...REQ, data: '0xad4c2381', gas: '350000' }),
    /no usable gas limit/,
  );
});

test('no dApp gas limit keeps the unchanged 1.2x rule and one block read for the base fee', async () => {
  estimateResponse = { result: '0x186a0' }; // 100000
  const tx = await rpc.buildTransaction({ ...REQ, data: '0xad4c2381' });
  assert.equal(tx.gas, '120000');
  assert.equal(
    methodsCalled().filter((m) => m === 'qrl_getBlockByNumber').length,
    1,
    'the ordinary send reads the latest block once, for the fee quote',
  );
});

test('one latest-block read serves both the fee quote and the dApp ceiling', async () => {
  estimateResponse = { result: '0x186a0' };
  const tx = await rpc.buildTransaction({ ...REQ, data: '0xad4c2381', gas: '350000' });
  assert.equal(tx.gas, '350000');
  assert.equal(tx.maxFeePerGas, '3750000014');
  assert.equal(methodsCalled().filter((m) => m === 'qrl_getBlockByNumber').length, 1);
});

test('a failed latest-block read falls back on fees but still fails a dApp gas build', async () => {
  estimateResponse = { result: '0x186a0' };
  latestBlockError = 'header not found';
  const tx = await rpc.buildTransaction({ ...REQ, data: '0xad4c2381' });
  assert.equal(tx.maxFeePerGas, '1200000000', 'gasPrice fallback tier');
  await assert.rejects(
    rpc.buildTransaction({ ...REQ, data: '0xad4c2381', gas: '350000' }),
    /header not found/,
    'the dApp ceiling is never skipped',
  );
});

// ---------------------------------------------------------------------------
// Block-gas-limit ceiling: parsing and the buffered-estimate clamp
// ---------------------------------------------------------------------------

test('an unusable latest-block gas limit is refused in every shape', async () => {
  estimateResponse = { result: '0x186a0' };
  for (const bad of ['0x0', '0x', 'not-hex', '30000000']) {
    latestBlockGasLimit = bad;
    await assert.rejects(
      rpc.buildTransaction({ ...REQ, data: '0xad4c2381', gas: '350000' }),
      /gas limit/,
      `latest block gasLimit ${JSON.stringify(bad)} must not pass`,
    );
  }
});

test('getBlockGasLimit rejects a zero, non-hex or decimal-string ceiling', async () => {
  for (const [bad, pattern] of [
    ['0x0', /zero gas limit/],
    ['0x', /no usable gas limit/],
    ['0xzz', /no usable gas limit/],
    ['30000000', /no usable gas limit/],
  ] as const) {
    latestBlockGasLimit = bad;
    await assert.rejects(rpc.getBlockGasLimit(), pattern, `ceiling ${bad}`);
  }
  latestBlockGasLimit = '0x1c9c380';
  assert.equal(await rpc.getBlockGasLimit(), 30_000_000n);
});

test('a numeric gasLimit from the node is refused at the read', async () => {
  // The node is expected to answer with an RPC quantity. A number is a
  // non-conforming answer, and coercing it would silently accept a ceiling
  // read in the wrong base.
  for (const bad of [30_000_000, 0]) {
    latestBlockGasLimit = bad;
    await assert.rejects(rpc.getBlockGasLimit(), /no usable gas limit/, `numeric ${bad}`);
  }
});

test('the buffered estimate is clamped to the block gas limit on the dApp path', async () => {
  // A near-block-sized call: 26,000,000 estimate buffers to 31,200,000, past a
  // 30,000,000 ceiling the requested value was already checked against.
  estimateResponse = { result: `0x${(26_000_000).toString(16)}` };
  latestBlockGasLimit = '0x1c9c380'; // 30,000,000
  const tx = await rpc.buildTransaction({ ...REQ, data: '0xad4c2381', gas: '21000' });
  assert.equal(tx.gas, '30000000', 'the floor never exceeds the ceiling');
});

test('the unbuffered estimate still wins when it fits under the ceiling', async () => {
  estimateResponse = { result: `0x${(20_000_000).toString(16)}` }; // -> 24,000,000
  latestBlockGasLimit = '0x1c9c380';
  const tx = await rpc.buildTransaction({ ...REQ, data: '0xad4c2381', gas: '21000' });
  assert.equal(tx.gas, '24000000');
});

// ---------------------------------------------------------------------------
// Build records: what the trusted confirm window is told about the build
// ---------------------------------------------------------------------------

test('a dApp build records both the estimate and the request', async () => {
  estimateResponse = { result: '0x186a0' }; // 100000 -> 120000 buffered
  const tx = await rpc.buildTransaction({ ...REQ, data: '0xad4c2381', gas: '350000' });
  assert.deepEqual(recallBuild(tx), { estimatedGas: '120000', requestedGas: '350000' });
});

test('a wallet-only build records the estimate and no request', async () => {
  estimateResponse = { result: '0x186a0' };
  const tx = await rpc.buildTransaction({ ...REQ, data: '0xad4c2381' });
  assert.deepEqual(recallBuild(tx), { estimatedGas: '120000' });
});

test('a request the estimate outgrew is still recorded next to that estimate', async () => {
  estimateResponse = { result: '0x186a0' };
  const tx = await rpc.buildTransaction({ ...REQ, data: '0xad4c2381', gas: '21000' });
  assert.equal(tx.gas, '120000', 'the estimate floored the limit');
  assert.deepEqual(recallBuild(tx), { estimatedGas: '120000', requestedGas: '21000' });
});

// ---------------------------------------------------------------------------
// Fee market: the node's suggested tip plus base-fee headroom
// ---------------------------------------------------------------------------

test('buildTransaction prices from the suggested tip and the latest base fee', async () => {
  const tx = await rpc.buildTransaction(REQ);
  assert.equal(tx.maxPriorityFeePerGas, '3750000000', '2.5 gwei suggestion * 1.5 (medium)');
  assert.equal(tx.maxFeePerGas, '3750000014', '2 * 7 wei base fee + tip');
  assert.ok(!methodsCalled().includes('qrl_gasPrice'), 'no gasPrice read on the market path');
});

test('each fee level scales the suggested tip like the web wallet', async () => {
  const expected = {
    low: ['2500000000', '2500000014'],
    medium: ['3750000000', '3750000014'],
    high: ['5000000000', '5000000014'],
  } as const;
  for (const feeLevel of ['low', 'medium', 'high'] as const) {
    const tx = await rpc.buildTransaction({ ...REQ, feeLevel });
    assert.deepEqual([tx.maxPriorityFeePerGas, tx.maxFeePerGas], expected[feeLevel], feeLevel);
  }
});

test('a rising base fee is covered by the 2x headroom in maxFeePerGas', async () => {
  latestBaseFee = '0x3b9aca00'; // 1 gwei
  const tx = await rpc.buildTransaction(REQ);
  assert.equal(tx.maxFeePerGas, '5750000000', '2 * 1 gwei + 3.75 gwei tip');
});

test('a node without qrl_maxPriorityFeePerGas falls back to the gasPrice tiers', async () => {
  tipResponse = { error: { code: -32601, message: 'the method does not exist' } };
  const tx = await rpc.buildTransaction(REQ);
  assert.equal(tx.maxFeePerGas, '1200000000', '1 gwei gasPrice * 1.2 (medium)');
  assert.equal(tx.maxPriorityFeePerGas, '1000000000');
});

test('the gasPrice fallback applies each level tier', async () => {
  tipResponse = { error: { code: -32601, message: 'the method does not exist' } };
  const expected = {
    low: ['1000000000', '1000000000'],
    medium: ['1000000000', '1200000000'],
    high: ['1000000000', '1500000000'],
  } as const;
  for (const feeLevel of ['low', 'medium', 'high'] as const) {
    const tx = await rpc.buildTransaction({ ...REQ, feeLevel });
    assert.deepEqual([tx.maxPriorityFeePerGas, tx.maxFeePerGas], expected[feeLevel], feeLevel);
  }
});

test('with neither fee read available the 1 gwei last resort still builds', async () => {
  tipResponse = { error: { code: -32601, message: 'the method does not exist' } };
  gasPriceAvailable = false;
  READ_RESULTS['qrl_gasPrice'] = '0x77359400'; // 2 gwei, which must go unread
  try {
    const tx = await rpc.buildTransaction(REQ);
    assert.equal(tx.maxPriorityFeePerGas, '1000000000');
    assert.equal(tx.maxFeePerGas, '1200000000');
  } finally {
    READ_RESULTS['qrl_gasPrice'] = '0x3b9aca00';
  }
});

test('a latest block without a base fee falls back to the gasPrice tiers', async () => {
  latestBaseFee = undefined;
  const tx = await rpc.buildTransaction(REQ);
  assert.equal(tx.maxFeePerGas, '1200000000');
  assert.equal(tx.maxPriorityFeePerGas, '1000000000');
});

test('a tip or base fee that is not an RPC quantity falls back to the gasPrice tiers', async () => {
  for (const [tip, base] of [
    [2_500_000_000, '0x7'],
    ['2500000000', '0x7'],
    ['0x9502f900', 7],
    ['0x9502f900', '7'],
  ] as const) {
    tipResponse = { result: tip };
    latestBaseFee = base;
    const tx = await rpc.buildTransaction(REQ);
    assert.equal(tx.maxFeePerGas, '1200000000', `tip ${String(tip)}, base ${String(base)}`);
  }
});
