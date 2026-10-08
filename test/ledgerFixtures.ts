/**
 * Replays APDU transcripts recorded against the QRL v2.0 Ledger app on Speculos
 * (test/fixtures/ledger/*.json). Each fixture names the app build it came from.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { fromHex, toHex } from '../src/ledger/bytes';
import type { LedgerTransport } from '../src/ledger/transport';

export interface RecordedExchange {
  label: string;
  apdu: string;
  response: string;
}

export interface LedgerFixture {
  flow: string;
  model: string;
  path?: string;
  expected?: Record<string, unknown>;
  exchanges: RecordedExchange[];
  [key: string]: unknown;
}

export function loadFixture(name: string): LedgerFixture {
  const url = new URL(`./fixtures/ledger/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as LedgerFixture;
}

export function expectedString(fixture: LedgerFixture, key: string): string {
  const value = fixture.expected?.[key];
  assert.equal(typeof value, 'string', `fixture expected.${key}`);
  return value as string;
}

export function fixturePath(fixture: LedgerFixture): string {
  assert.equal(typeof fixture.path, 'string', 'fixture path');
  return fixture.path as string;
}

/** The preimage the transcript streamed: the data of every SIGN_TX P1=1/P1=2 data APDU. */
export function streamedPreimage(fixture: LedgerFixture): Uint8Array {
  const parts = fixture.exchanges
    .map((e) => fromHex(e.apdu))
    .filter((a) => a[1] === 0x06 && (a[2] === 1 || a[2] === 2) && a[3] === 0);
  const total = parts.reduce((n, a) => n + a.length - 5, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of parts) {
    out.set(a.subarray(5), offset);
    offset += a.length - 5;
  }
  return out;
}

/** Answers each APDU with the recorded response after checking it byte for byte. */
export class ReplayTransport implements LedgerTransport {
  private readonly exchanges: readonly RecordedExchange[];
  private index = 0;

  constructor(exchanges: readonly RecordedExchange[]) {
    this.exchanges = exchanges;
  }

  async exchange(apdu: Uint8Array): Promise<Uint8Array> {
    const next = this.exchanges[this.index];
    assert.ok(next, `unexpected extra APDU ${toHex(apdu)}`);
    assert.equal(toHex(apdu), next.apdu, `APDU ${this.index} (${next.label})`);
    this.index += 1;
    return fromHex(next.response);
  }

  assertDone(): void {
    assert.equal(this.index, this.exchanges.length, 'every recorded APDU was replayed');
  }
}
