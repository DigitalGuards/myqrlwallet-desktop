/**
 * Gas policy for the transaction builder (src/main/rpc.ts buildTransaction):
 *
 *   - no calldata: fixed 21000, qrl_estimateGas is never consulted
 *   - calldata present: qrl_estimateGas result with a 1.2x buffer (web-wallet
 *     parity), replacing the old fixed 90k limit that starved real contract
 *     calls (an HTLC lock writes ~7 fresh slots, ~175k gas) into guaranteed
 *     on-chain reverts
 *   - an estimate rejection (the call would revert) propagates: refusing to
 *     build beats signing a transaction that burns its whole gas limit
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

let methods: string[] = [];
let estimateResponse: { result?: string; error?: { code: number; message: string } };

const realFetch = globalThis.fetch;

const READ_RESULTS: Record<string, string> = {
  qrl_getTransactionCount: '0x5',
  qrl_gasPrice: '0x3b9aca00', // 1 gwei
  qrl_chainId: '0x539',
};

beforeEach(() => {
  methods = [];
  estimateResponse = { result: '0x249f0' }; // 150000
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    const { method } = JSON.parse(String(init?.body)) as { method: string };
    methods.push(method);
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
  from: `Q${'11'.repeat(20)}`,
  to: `Q${'22'.repeat(20)}`,
  value: '1000000000000000000',
  feeLevel: 'medium' as const,
};

test('buildTransaction uses fixed 21000 gas for native transfers (no estimate call)', async () => {
  const tx = await rpc.buildTransaction(REQ);
  assert.equal(tx.gas, '21000');
  assert.ok(!methods.includes('qrl_estimateGas'), 'no estimate for plain transfers');
});

test('buildTransaction estimates contract calls and applies the 1.2x buffer', async () => {
  const tx = await rpc.buildTransaction({ ...REQ, data: '0xad4c2381' });
  assert.equal(tx.gas, '180000', '150000 estimate * 1.2 buffer');
  assert.ok(methods.includes('qrl_estimateGas'));
});

test('buildTransaction surfaces an estimate rejection instead of building a doomed tx', async () => {
  estimateResponse = { error: { code: -32000, message: 'execution reverted' } };
  await assert.rejects(rpc.buildTransaction({ ...REQ, data: '0xdeadbeef' }), /execution reverted/);
});
