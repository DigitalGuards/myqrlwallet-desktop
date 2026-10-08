import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { cryptoSignVerify } from '@theqrl/mldsa87';

import { LedgerError, QrlLedger, qrlAddressFromPublicKey } from '../src/ledger';
import { decodeResponse } from '../src/ledger/apdu';
import { fromHex, toHex } from '../src/ledger/bytes';
import { statusError } from '../src/ledger/errors';
import type { LedgerTransport } from '../src/ledger/transport';
import {
  ReplayTransport,
  appCheckExchange,
  expectedString,
  fixturePath,
  loadFixture,
  streamedPreimage,
  withAppCheck,
} from './ledgerFixtures';

// "ZOND" || signing-context version 01 || ML-DSA-87 descriptor 01 00 00
const TX_SIGNING_CONTEXT = Uint8Array.from([0x5a, 0x4f, 0x4e, 0x44, 0x01, 0x01, 0x00, 0x00]);
const PATH = "m/44'/238'/0'/0/0";

async function rejects(promise: Promise<unknown>, check: Partial<LedgerError>): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof LedgerError, `expected LedgerError, got ${String(error)}`);
    for (const [key, value] of Object.entries(check)) {
      assert.equal(error[key as keyof LedgerError], value, `LedgerError.${key}`);
    }
    return true;
  });
}

/** Answers in order without checking the APDUs; records how many were sent. */
function scripted(responses: string[]): LedgerTransport & { sent: string[] } {
  let i = 0;
  const sent: string[] = [];
  return {
    sent,
    async exchange(apdu: Uint8Array): Promise<Uint8Array> {
      sent.push(toHex(apdu));
      const next = responses[i++];
      assert.ok(next !== undefined, 'scripted transport ran out of responses');
      return fromHex(next);
    },
  };
}

function appInfoReply(name: string, version: string): string {
  const enc = (s: string): string => toHex(new TextEncoder().encode(s));
  const len = (s: string): string => s.length.toString(16).padStart(2, '0');
  return `01${len(name)}${enc(name)}${len(version)}${enc(version)}01009000`;
}

for (const build of ['theqrl', 'pr7']) {
  test(`${build}: identifies the app, then derives the account and reads its public key`, async () => {
    const fixture = loadFixture(`${build}-nanosp-identity.json`);
    const [app, version, name, ...derive] = fixture.exchanges;
    assert.ok(app && version && name);
    const transport = new ReplayTransport([app, app, version, app, name, app, ...derive]);
    const ledger = new QrlLedger(transport);

    assert.deepEqual(await ledger.requireQrlApp(), { name: 'QRL v2.0', version: '2.2.2' });
    assert.deepEqual(await ledger.getVersion(), { major: 2, minor: 2, patch: 2 });
    assert.equal(await ledger.getAppName(), 'QRL v2.0');
    const account = await ledger.getAccount(fixturePath(fixture));

    assert.equal(account.address, `Q${expectedString(fixture, 'address')}`);
    assert.equal(toHex(account.publicKey), expectedString(fixture, 'publicKey'));
    assert.equal(qrlAddressFromPublicKey(account.publicKey), account.address);
    transport.assertDone();
  });
}

test('keygen parity: the theQRL build and cyyber PR #7 derive the same key for one seed and path', () => {
  const theqrl = loadFixture('theqrl-nanosp-identity.json');
  const pr7 = loadFixture('pr7-nanosp-identity.json');
  assert.equal(expectedString(theqrl, 'address'), expectedString(pr7, 'address'));
  assert.equal(expectedString(theqrl, 'publicKey'), expectedString(pr7, 'publicKey'));
});

for (const name of [
  'theqrl-nanosp-sign-live.json',
  'pr7-nanosp-sign-live.json',
  'theqrl-stax-sign.json',
  'theqrl-nanosp-sign-blind.json',
]) {
  test(`${name}: streams the preimage and reassembles a signature that verifies`, async () => {
    const fixture = loadFixture(name);
    const preimage = fromHex(expectedString(fixture, 'preimage'));
    const publicKey = fromHex(expectedString(fixture, 'publicKey'));
    const transport = new ReplayTransport(withAppCheck(fixture.exchanges));

    const signature = await new QrlLedger(transport).signTransactionPreimage(
      fixturePath(fixture),
      preimage,
    );

    assert.equal(signature.length, 4627);
    assert.equal(toHex(signature), expectedString(fixture, 'signature'));
    const sighash = keccak_256(preimage);
    assert.equal(toHex(sighash), expectedString(fixture, 'sighash'));
    assert.ok(cryptoSignVerify(signature, sighash, publicKey, TX_SIGNING_CONTEXT));
    assert.ok(!cryptoSignVerify(signature, new Uint8Array(32), publicKey, TX_SIGNING_CONTEXT));
    transport.assertDone();
  });
}

test('the live fixtures sign from the address their public key hashes to', () => {
  for (const name of ['theqrl-nanosp-sign-live.json', 'pr7-nanosp-sign-live.json']) {
    const fixture = loadFixture(name);
    const from = fixture.from;
    assert.equal(typeof from, 'string');
    const derived = qrlAddressFromPublicKey(fromHex(expectedString(fixture, 'publicKey')));
    assert.equal(derived, `Q${(from as string).slice(1).toLowerCase()}`);
  }
});

for (const build of ['theqrl', 'pr7']) {
  test(`${build}: on-device address verification resolves with the address`, async () => {
    const identity = loadFixture(`${build}-nanosp-identity.json`);
    const transport = new ReplayTransport(
      withAppCheck(loadFixture(`${build}-nanosp-verify-address-approve.json`).exchanges),
    );
    const address = await new QrlLedger(transport).verifyAddress(PATH);
    assert.equal(address, `Q${expectedString(identity, 'address')}`);
    transport.assertDone();
  });

  test(`${build}: cancelling the address on the device rejects`, async () => {
    const transport = new ReplayTransport(
      withAppCheck(loadFixture(`${build}-nanosp-verify-address-reject.json`).exchanges),
    );
    await rejects(new QrlLedger(transport).verifyAddress(PATH), {
      code: 'rejected',
      sw: 0x6985,
      needsBlindSigning: false,
    });
    transport.assertDone();
  });

  test(`${build}: rejecting a transaction on the device rejects`, async () => {
    const fixture = loadFixture(`${build}-nanosp-sign-reject.json`);
    const transport = new ReplayTransport(withAppCheck(fixture.exchanges));
    await rejects(
      new QrlLedger(transport).signTransactionPreimage(PATH, streamedPreimage(fixture)),
      { code: 'rejected', sw: 0x6985, needsBlindSigning: false },
    );
    transport.assertDone();
  });
}

test('blind signing off: the theQRL build answers 6985 at once, flagged as a blind sign', async () => {
  const fixture = loadFixture('theqrl-nanosp-blind-signing-disabled.json');
  const transport = new ReplayTransport(withAppCheck(fixture.exchanges));
  await rejects(new QrlLedger(transport).signTransactionPreimage(PATH, streamedPreimage(fixture)), {
    code: 'rejected',
    sw: 0x6985,
    needsBlindSigning: true,
  });
  transport.assertDone();
});

test('blind signing off: the cyyber PR #7 build answers B008, flagged as a blind sign', async () => {
  // B008 is how the cyyber builds refuse a blind sign while the setting is off.
  // On the theQRL build B008 only means signing failed after approval, so the
  // mapping stays `signature-failed` and the flag carries the blind-sign hint.
  const fixture = loadFixture('pr7-nanosp-blind-signing-disabled.json');
  const transport = new ReplayTransport(withAppCheck(fixture.exchanges));
  await rejects(new QrlLedger(transport).signTransactionPreimage(PATH, streamedPreimage(fixture)), {
    code: 'signature-failed',
    sw: 0xb008,
    needsBlindSigning: true,
  });
  transport.assertDone();
});

test('oversized preimage: refused before any APDU with the default 510-byte bound', async () => {
  const fixture = loadFixture('theqrl-nanosp-oversized.json');
  const transport = new ReplayTransport([]);
  await rejects(new QrlLedger(transport).signTransactionPreimage(PATH, streamedPreimage(fixture)), {
    code: 'tx-too-large',
    sw: undefined,
  });
  transport.assertDone();
});

test('oversized preimage: the theQRL build answers B004 once 510 bytes are buffered', async () => {
  const fixture = loadFixture('theqrl-nanosp-oversized.json');
  const transport = new ReplayTransport(withAppCheck(fixture.exchanges));
  const ledger = new QrlLedger(transport, { maxPreimageBytes: 2048 });
  await rejects(ledger.signTransactionPreimage(PATH, streamedPreimage(fixture)), {
    code: 'tx-too-large',
    sw: 0xb004,
  });
  transport.assertDone();
});

test('oversized preimage: the cyyber PR #7 build buffers it and refuses the blind sign', async () => {
  const fixture = loadFixture('pr7-nanosp-oversized.json');
  const transport = new ReplayTransport(withAppCheck(fixture.exchanges));
  const ledger = new QrlLedger(transport, { maxPreimageBytes: 2048 });
  await rejects(ledger.signTransactionPreimage(PATH, streamedPreimage(fixture)), {
    code: 'signature-failed',
    sw: 0xb008,
    needsBlindSigning: true,
  });
  transport.assertDone();
});

test('recorded wrong-CLA and unknown-INS answers map to wrong-app and unsupported', () => {
  for (const build of ['theqrl', 'pr7']) {
    const [cla, ins] = loadFixture(`${build}-nanosp-bad-cla-ins.json`).exchanges;
    assert.ok(cla && ins);
    assert.equal(statusError(decodeResponse(fromHex(cla.response)).sw).code, 'wrong-app');
    assert.equal(statusError(decodeResponse(fromHex(ins.response)).sw).code, 'unsupported');
  }
});

test('requireQrlApp refuses the dashboard and the QRL 1.0 app', async () => {
  for (const name of ['BOLOS', 'QRL']) {
    await rejects(new QrlLedger(scripted([appInfoReply(name, '1.0.0')])).requireQrlApp(), {
      code: 'wrong-app',
    });
  }
});

test('with another app open, account and signing requests send nothing after B0 01', async () => {
  const live = loadFixture('theqrl-nanosp-sign-live.json');
  const preimage = fromHex(expectedString(live, 'preimage'));
  const requests: Array<(ledger: QrlLedger) => Promise<unknown>> = [
    (ledger) => ledger.getAccount(PATH),
    (ledger) => ledger.verifyAddress(PATH),
    (ledger) => ledger.signTransactionPreimage(PATH, preimage),
    (ledger) => ledger.getVersion(),
  ];
  for (const request of requests) {
    const transport = scripted([appInfoReply('Ethereum', '1.13.0')]);
    await rejects(request(new QrlLedger(transport)), { code: 'wrong-app' });
    assert.deepEqual(transport.sent, ['b001000000']);
  }
});

test('a locked device maps to locked', async () => {
  await rejects(new QrlLedger(scripted(['5515'])).getAppInfo(), { code: 'locked', sw: 0x5515 });
});

test('malformed device answers are refused', async () => {
  const identity = loadFixture('theqrl-nanosp-identity.json');
  const app = appCheckExchange().response;
  const responses = identity.exchanges.slice(3).map((e) => e.response);

  // Address without the Q prefix.
  const noPrefix = [app, `52${responses[0]?.slice(2)}`, ...responses.slice(1)];
  await rejects(new QrlLedger(scripted(noPrefix)).getAccount(PATH), {
    code: 'malformed-response',
  });

  // A public key chunk one byte short.
  const shortChunk = [app, ...responses];
  shortChunk[2] = `${responses[1]?.slice(0, -6)}9000`;
  await rejects(new QrlLedger(scripted(shortChunk)).getAccount(PATH), {
    code: 'malformed-response',
  });

  // A public key that does not hash to the address.
  const tampered = [app, ...responses];
  const chunk = responses[5] ?? '';
  tampered[6] = `${chunk.slice(0, 10)}${chunk[10] === '0' ? '1' : '0'}${chunk.slice(11)}`;
  await rejects(new QrlLedger(scripted(tampered)).getAccount(PATH), { code: 'key-mismatch' });

  // A response shorter than a status word.
  await rejects(new QrlLedger(scripted(['90'])).getAppInfo(), { code: 'malformed-response' });
});

test('a short signature chunk is refused', async () => {
  const fixture = loadFixture('theqrl-nanosp-sign-live.json');
  const responses = [appCheckExchange().response, ...fixture.exchanges.map((e) => e.response)];
  const last = responses.length - 1;
  responses[last] = `${responses[last]?.slice(0, -6)}9000`;
  await rejects(
    new QrlLedger(scripted(responses)).signTransactionPreimage(
      PATH,
      fromHex(expectedString(fixture, 'preimage')),
    ),
    { code: 'malformed-response' },
  );
});

test('transport failures surface as transport errors', async () => {
  const failing: LedgerTransport = {
    async exchange(): Promise<Uint8Array> {
      throw new Error('device unplugged');
    },
  };
  await rejects(new QrlLedger(failing).getVersion(), { code: 'transport' });
});

test('input checks reject before any APDU', async () => {
  const transport = new ReplayTransport([]);
  const ledger = new QrlLedger(transport);
  await rejects(ledger.getAccount("m/44'/60'/0'/0/0"), { code: 'invalid-path' });
  await rejects(ledger.verifyAddress("m/44'/238'/0/0/0"), { code: 'invalid-path' });
  await rejects(ledger.signTransactionPreimage("m/44'/238'/0'/0'/0", Uint8Array.from([2])), {
    code: 'invalid-path',
  });
  await rejects(ledger.signTransactionPreimage(PATH, Uint8Array.from([1, 0xc0])), {
    code: 'invalid-preimage',
  });
  transport.assertDone();
});

test('clients that share a transport run their jobs one at a time', async () => {
  const identity = loadFixture('theqrl-nanosp-identity.json');
  const job = withAppCheck(identity.exchanges.slice(3));
  const replay = new ReplayTransport([...job, ...job, ...job]);
  const slow: LedgerTransport = {
    async exchange(apdu: Uint8Array): Promise<Uint8Array> {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return replay.exchange(apdu);
    },
  };
  const first = new QrlLedger(slow);
  const second = new QrlLedger(slow);
  const results = await Promise.all([
    first.getAccount(PATH),
    second.getAccount(PATH),
    first.getAccount(PATH),
  ]);
  assert.ok(results.every((r) => r.address === results[0]?.address));
  replay.assertDone();
});
