import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LedgerError, createSpeculosTransport } from '../src/ledger';
import { toHex } from '../src/ledger/bytes';

type FetchCall = { url: string; init: RequestInit | undefined };

function fakeFetch(reply: () => Response, calls: FetchCall[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return reply();
  }) as typeof fetch;
}

const isTransportError = (error: unknown): boolean =>
  error instanceof LedgerError && error.code === 'transport';

test('packaged builds refuse the emulator', () => {
  assert.throws(
    () => createSpeculosTransport({ baseUrl: 'http://127.0.0.1:5000', isPackaged: true }),
    isTransportError,
  );
});

test('only plain http loopback origins are accepted', () => {
  for (const baseUrl of [
    'http://192.0.2.10:5000',
    'http://example.com:5000',
    'https://127.0.0.1:5000',
    'http://user:pw@127.0.0.1:5000',
    'http://127.0.0.1:5000/apdu',
    'http://127.0.0.1:5000/?x=1',
    'not a url',
  ]) {
    assert.throws(
      () => createSpeculosTransport({ baseUrl, isPackaged: false }),
      isTransportError,
      baseUrl,
    );
  }
  for (const baseUrl of ['http://127.0.0.1:5000', 'http://localhost:5000/', 'http://[::1]:5000']) {
    assert.doesNotThrow(() => createSpeculosTransport({ baseUrl, isPackaged: false }), baseUrl);
  }
});

test('posts the APDU as hex to /apdu and returns the response bytes', async () => {
  const calls: FetchCall[] = [];
  const transport = createSpeculosTransport({
    baseUrl: 'http://127.0.0.1:5000',
    isPackaged: false,
    fetch: fakeFetch(() => Response.json({ data: '0202029000' }), calls),
  });
  const response = await transport.exchange(Uint8Array.from([0xe0, 0x03, 0, 0, 0]));
  assert.equal(toHex(response), '0202029000');
  assert.equal(calls[0]?.url, 'http://127.0.0.1:5000/apdu');
  assert.equal(calls[0]?.init?.method, 'POST');
  assert.equal(calls[0]?.init?.body, JSON.stringify({ data: 'e003000000' }));
});

test('HTTP errors, bad replies, and network failures are transport errors', async () => {
  const replies: Array<() => Response> = [
    () => new Response('nope', { status: 500 }),
    () => Response.json({ data: 'zz' }),
    () => Response.json({ data: '90' }),
    () => Response.json({ data: '9000', extra: true }),
    () => new Response('not json', { status: 200 }),
  ];
  for (const reply of replies) {
    const transport = createSpeculosTransport({
      baseUrl: 'http://127.0.0.1:5000',
      isPackaged: false,
      fetch: fakeFetch(reply),
    });
    await assert.rejects(
      transport.exchange(Uint8Array.from([0xe0, 0x03, 0, 0, 0])),
      isTransportError,
    );
  }
  const down = createSpeculosTransport({
    baseUrl: 'http://127.0.0.1:5000',
    isPackaged: false,
    fetch: (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch,
  });
  await assert.rejects(down.exchange(Uint8Array.from([0xe0, 0x03, 0, 0, 0])), isTransportError);
});
