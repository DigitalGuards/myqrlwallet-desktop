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
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    const { method, params } = JSON.parse(String(init?.body)) as RecordedCall;
    // The genesis read is the endpoint-identity probe every call makes; the
    // 'latest' read is the block-gas-limit ceiling, which only the dApp-gas
    // path takes, so record that one.
    if (method === 'qrl_getBlockByNumber' && params[0] === '0x0') {
      return Promise.resolve(
        new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, result: { hash: EXPECTED_GENESIS_HASH } }),
        ),
      );
    }
    calls.push({ method, params });
    if (method === 'qrl_getBlockByNumber') {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: latestBlockGasLimit === undefined ? {} : { gasLimit: latestBlockGasLimit },
          }),
        ),
      );
    }
    const payload =
      method === 'qrl_estimateGas'
        ? { jsonrpc: '2.0', id: 1, ...estimateResponse }
        : { jsonrpc: '2.0', id: 1, result: READ_RESULTS[method] ?? '0x0' };
    return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
  }) as typeof fetch;
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
      maxFeePerGas: '0x47868c00',
      maxPriorityFeePerGas: '0x3b9aca00',
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

test('no dApp gas limit means no extra block read and the unchanged 1.2x rule', async () => {
  estimateResponse = { result: '0x186a0' }; // 100000
  const tx = await rpc.buildTransaction({ ...REQ, data: '0xad4c2381' });
  assert.equal(tx.gas, '120000');
  assert.equal(
    methodsCalled().filter((m) => m === 'qrl_getBlockByNumber').length,
    0,
    'the ordinary send keeps its existing RPC round trips',
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

test('a numeric gasLimit from the node is refused, never coerced', async () => {
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

test('the recorded estimate is the comparison value, even when the request wins', async () => {
  estimateResponse = { result: '0x186a0' };
  const tx = await rpc.buildTransaction({ ...REQ, data: '0xad4c2381', gas: '21000' });
  assert.equal(tx.gas, '120000', 'the estimate floored the limit');
  assert.deepEqual(recallBuild(tx), { estimatedGas: '120000', requestedGas: '21000' });
});
