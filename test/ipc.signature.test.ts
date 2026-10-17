import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXPECTED_CHAIN_ID, EXPECTED_GENESIS_HASH } from '../src/main/config';
import { signWithConfirmation } from '../src/main/signatureRequest';
import { clearBuildRecords, rememberBuild } from '../src/main/buildRecords';
import { isRecord } from '../src/shared/guards';
import { parseSignerRequest } from '../src/shared/protocolGuards';
import { SignatureRequestSchema } from '../src/shared/schemas';
import { signMessage, signTypedData } from '../src/signer/signing';
import { canonical, SIGNER } from './typedDataFixtures';

for (const kind of ['message', 'typedData'] as const) {
  test(`IPC signing handoff passes the configured chain id for offline ${kind} requests`, async (t) => {
    const vector = canonical.schemeSigningVectors[0];
    assert.ok(vector);
    const request = SignatureRequestSchema.parse(
      kind === 'message'
        ? { kind, signer: vector.signer, messageHex: '0x6869' }
        : { kind, signer: vector.signer, payload: vector.payload },
    );
    const expected =
      kind === 'message'
        ? signMessage(vector.hexSeed, '0x6869')
        : signTypedData(vector.hexSeed, vector.payload, false);
    const network = t.mock.method(globalThis, 'fetch', () => {
      throw new Error('offline signing attempted network access');
    });
    const steps: string[] = [];
    const result = await signWithConfirmation(request, {
      signer: {
        status: () => {
          steps.push('status');
          return Promise.resolve({ unlocked: true, address: vector.signer, unlockExpiresAt: null });
        },
        sign: (received, chainId) => {
          steps.push('sign');
          assert.equal(received, request);
          assert.equal(chainId, EXPECTED_CHAIN_ID);
          const wire = parseSignerRequest({
            type: 'signer:sign',
            id: 1,
            request: received,
            chainId,
          });
          assert.ok(wire?.type === 'signer:sign');
          assert.equal(wire.chainId, EXPECTED_CHAIN_ID);
          return Promise.resolve(expected);
        },
      },
      confirm: (received, context) => {
        steps.push('confirm');
        assert.equal(received, request);
        assert.deepEqual(context, { connectedChainId: EXPECTED_CHAIN_ID });
        return Promise.resolve(true);
      },
    });
    assert.equal(result, expected);
    assert.deepEqual(steps, ['status', 'confirm', 'sign']);
    assert.equal(network.mock.callCount(), 0);
  });
}

test('IPC signing handoff preserves account binding and rejection before signing', async () => {
  const request = SignatureRequestSchema.parse({
    kind: 'message',
    signer: SIGNER,
    messageHex: '0x6869',
  });
  for (const mismatch of [true, false]) {
    let confirmations = 0;
    let signatures = 0;
    await assert.rejects(
      signWithConfirmation(request, {
        signer: {
          status: () =>
            Promise.resolve({
              unlocked: true,
              address: mismatch ? `Q${'b'.repeat(128)}` : SIGNER,
              unlockExpiresAt: null,
            }),
          sign: () => {
            signatures++;
            return Promise.reject(new Error('unexpected signing'));
          },
        },
        confirm: () => {
          confirmations++;
          return Promise.resolve(false);
        },
      }),
      mismatch ? /account mismatch/ : /user rejected signature/,
    );
    assert.equal(confirmations, mismatch ? 0 : 1);
    assert.equal(signatures, 0);
  }
});

test('IPC transaction handoff retains node identity, gas ceiling and build provenance', async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', (_input: unknown, init?: { body?: unknown }) => {
    const body: unknown = JSON.parse(String(init?.body));
    assert.ok(isRecord(body) && typeof body['method'] === 'string');
    calls.push(body['method']);
    const result =
      body['method'] === 'qrl_chainId'
        ? `0x${EXPECTED_CHAIN_ID.toString(16)}`
        : { hash: EXPECTED_GENESIS_HASH, gasLimit: '0x1c9c380' };
    return Promise.resolve(Response.json({ jsonrpc: '2.0', id: body['id'], result }));
  });
  t.after(clearBuildRecords);
  const request = SignatureRequestSchema.parse({
    kind: 'transaction',
    tx: {
      from: SIGNER,
      to: SIGNER,
      value: '0',
      nonce: 0,
      gas: '350000',
      maxFeePerGas: '1',
      maxPriorityFeePerGas: '1',
      chainId: EXPECTED_CHAIN_ID,
      type: '0x2',
    },
  });
  assert.ok(request.kind === 'transaction');
  const build = { estimatedGas: '120000', requestedGas: '350000' };
  rememberBuild(request.tx, build);
  let confirmations = 0;
  let signatures = 0;
  const deps: Parameters<typeof signWithConfirmation>[1] = {
    signer: {
      status: () => Promise.resolve({ unlocked: true, address: SIGNER, unlockExpiresAt: null }),
      sign: (received, chainId) => {
        assert.equal(received, request);
        assert.equal(chainId, EXPECTED_CHAIN_ID);
        signatures++;
        return Promise.resolve({
          kind: 'transaction',
          signer: SIGNER,
          signature: '0x02',
          rawTransaction: '0x02',
        });
      },
    },
    confirm: (received, context) => {
      assert.equal(received, request);
      assert.deepEqual(context, { build, blockGasLimit: 30_000_000n });
      confirmations++;
      return Promise.resolve(true);
    },
  };
  await signWithConfirmation(request, deps);
  assert.ok(calls.includes('qrl_chainId'));
  assert.ok(calls.includes('qrl_getBlockByNumber'));
  request.tx.chainId = EXPECTED_CHAIN_ID + 1;
  await assert.rejects(signWithConfirmation(request, deps), /chain id does not match/);
  request.tx.chainId = EXPECTED_CHAIN_ID;
  request.tx.gas = '30000001';
  await assert.rejects(signWithConfirmation(request, deps), /exceeds the block gas limit/);
  assert.equal(confirmations, 1);
  assert.equal(signatures, 1);
});
