/**
 * Development transport to the Speculos emulator's REST API (POST /apdu).
 *
 * Speculos stands in for a Ledger during development and testing. It is
 * refused in packaged builds and only reaches a loopback address: an endpoint
 * that answered as a device could otherwise supply addresses and keys to the
 * wallet. The caller passes `app.isPackaged`; this module never imports
 * electron, so it also runs under node:test.
 */
import { z } from 'zod';
import { fromHex, toHex } from './bytes';
import { LedgerError } from './errors';
import type { LedgerTransport } from './transport';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
/** Covers a review on the emulated screen; the caller's own timers bound real use. */
const DEFAULT_TIMEOUT_MS = 300_000;

const ApduReplySchema = z.object({ data: z.string().regex(/^(?:[0-9a-fA-F]{2}){2,}$/) }).strict();

export interface SpeculosTransportOptions {
  /** Speculos REST base URL, for example http://127.0.0.1:5000 */
  baseUrl: string;
  /** Pass `app.isPackaged`; packaged builds refuse the emulator. */
  isPackaged: boolean;
  timeoutMs?: number;
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

export function createSpeculosTransport(options: SpeculosTransportOptions): LedgerTransport {
  if (options.isPackaged) {
    throw new LedgerError(
      'transport',
      'The Speculos transport is available in development builds only',
    );
  }
  let url: URL;
  try {
    url = new URL(options.baseUrl);
  } catch {
    throw new LedgerError('transport', 'Invalid Speculos URL');
  }
  if (
    url.protocol !== 'http:' ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    url.username !== '' ||
    url.password !== '' ||
    (url.pathname !== '/' && url.pathname !== '') ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new LedgerError('transport', 'The Speculos URL must be a plain http loopback origin');
  }
  const endpoint = `${url.origin}/apdu`;
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async exchange(apdu: Uint8Array): Promise<Uint8Array> {
      let res: Response;
      try {
        res = await doFetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ data: toHex(apdu) }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new LedgerError('transport', `Speculos request failed: ${reason}`);
      }
      if (!res.ok) throw new LedgerError('transport', `Speculos answered HTTP ${res.status}`);
      const parsed = ApduReplySchema.safeParse(await res.json().catch(() => null));
      if (!parsed.success) throw new LedgerError('transport', 'Speculos returned an invalid reply');
      return fromHex(parsed.data.data);
    },
  };
}
