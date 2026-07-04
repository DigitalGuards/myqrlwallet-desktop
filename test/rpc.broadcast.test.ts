/**
 * Broadcast failover semantics (src/main/rpc.ts sendRawTransaction):
 *
 *   - a TRANSPORT failure on the primary (unreachable/reset/timeout/non-2xx)
 *     fails over to the secondary; the returned hash comes from there
 *   - a JSON-RPC error from the primary (a node ANSWERED and rejected the tx)
 *     surfaces immediately and the secondary is NEVER contacted
 *   - a transport failure on both endpoints throws an error that names the
 *     failing endpoint + detail (not undici's bare "fetch failed")
 *
 * fetch is mocked; the RPC endpoints are pinned via env BEFORE the module
 * import (config.ts reads env at import time), and rpc.ts is loaded with a
 * dynamic import so the pin is in place first.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env['QRL_RPC_URL'] = 'https://primary.example/api/qrl-rpc/testnet';
process.env['QRL_RPC_URL_SECONDARY'] = 'https://secondary.example/api/qrl-rpc/testnet';

const rpc = await import('../src/main/rpc');

type FetchArgs = { url: string; body: unknown };
let calls: FetchArgs[] = [];
let responder: (url: string) => Response | Error;

function rpcOk(result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 });
}

function rpcErr(message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message } }), {
    status: 200,
  });
}

beforeEach(() => {
  calls = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, body: init?.body });
    const out = responder(url);
    if (out instanceof Error) return Promise.reject(out);
    return Promise.resolve(out);
  }) as typeof fetch;
});

function connReset(): Error {
  // Shape of undici's failure: TypeError('fetch failed') with a coded cause.
  const cause = Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET' });
  return Object.assign(new TypeError('fetch failed'), { cause });
}

test('primary transport failure fails over to the secondary', async () => {
  responder = (url) => (url.includes('primary') ? connReset() : rpcOk('0xhash1'));
  const { transactionHash } = await rpc.sendRawTransaction('0xdead');
  assert.equal(transactionHash, '0xhash1');
  assert.equal(calls.length, 2);
  assert.ok(calls[0]?.url.includes('primary'));
  assert.ok(calls[1]?.url.includes('secondary'));
});

test('a JSON-RPC rejection from the primary surfaces and never touches the secondary', async () => {
  responder = (url) => (url.includes('primary') ? rpcErr('nonce too low') : rpcOk('0xnever'));
  await assert.rejects(rpc.sendRawTransaction('0xdead'), /nonce too low/);
  assert.equal(calls.length, 1, 'secondary must not be contacted');
});

test('a non-2xx gateway response counts as transport and fails over', async () => {
  responder = (url) =>
    url.includes('primary') ? new Response('bad gateway', { status: 502 }) : rpcOk('0xhash2');
  const { transactionHash } = await rpc.sendRawTransaction('0xdead');
  assert.equal(transactionHash, '0xhash2');
  assert.equal(calls.length, 2);
});

test('transport failure on both endpoints names the endpoint and detail', async () => {
  responder = () => connReset();
  await assert.rejects(rpc.sendRawTransaction('0xdead'), (err: unknown) => {
    assert.ok(err instanceof rpc.RpcTransportError);
    assert.match(err.message, /secondary\.example/);
    assert.match(err.message, /ECONNRESET/);
    return true;
  });
  assert.equal(calls.length, 2);
});

test('reads fail over on ANY primary error, including JSON-RPC errors (unchanged semantics)', async () => {
  responder = (url) => (url.includes('primary') ? rpcErr('boom') : rpcOk('0x539'));
  const chainId = await rpc.getChainId();
  assert.equal(chainId, 1337);
  assert.equal(calls.length, 2);
});
