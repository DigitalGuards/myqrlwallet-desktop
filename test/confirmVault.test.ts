import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  summariseSignatureRequest,
  typedDataDisplayLines,
  SIGNATURE_APPROVAL_NOTE,
} from '../src/main/confirmSummary';
import { groupQrlAddress } from '../src/shared/address';
import { isRecord } from '../src/shared/guards';
import {
  recognizeVaultRequest,
  VAULT_MAX_UINT256,
  VAULT_TX_FIELDS,
} from '../src/shared/quantaVault';
import { VAULT_ROLES } from '../src/shared/quantaVaultSelectors';
import { signWithConfirmation } from '../src/main/signatureRequest';
import { computeTypedDataDigest } from '../src/signer/typedData';
import { assertDetailWidth, assertTrustedLineStarts, unfoldDetail } from './confirmLayout';
import {
  vaultBatchPayload,
  vaultCalldata,
  vaultPayload,
  vaultTestAddress,
} from './quantaVaultFixtures';
import { typedRequest, SIGNER, payloadWith } from './typedDataFixtures';
import type { TypedDataPayload } from '../src/shared/typedData';
import { SignatureRequestSchema, type SignatureResult } from '../src/shared/schemas';
import timelockVault from './fixtures/quantaVault/timelock-vault.json';

function review(payload: TypedDataPayload, connectedChainId = 1) {
  const request = typedRequest(payload);
  const snapshot = structuredClone(request);
  const { pages } = summariseSignatureRequest(request, { connectedChainId });
  assert.deepEqual(request, snapshot);
  assert.ok(pages.length <= 10);
  for (const page of pages) {
    const displayed = `${page}\n\n${SIGNATURE_APPROVAL_NOTE}`;
    assertDetailWidth(page);
    assertTrustedLineStarts(page);
    assert.ok(typedDataDisplayLines(displayed) <= 30, displayed);
  }
  const rows = pages.flatMap((page) => unfoldDetail(page).split('\n'));
  const raw = rows.filter((row) => row.startsWith('message.'));
  // Changing only the name disables recognition and yields the original raw review.
  const generic = structuredClone(payload);
  generic.domain['name'] = 'Generic';
  const genericRows = summariseSignatureRequest(typedRequest(generic), { connectedChainId })
    .pages.flatMap((page) => unfoldDetail(page).split('\n'))
    .filter((row) => row.startsWith('message.'));
  assert.deepEqual(raw, genericRows, 'every raw row remains complete, once, in order');
  assert.ok(
    rows.findLastIndex((row) => row.startsWith('Vault ')) <
      rows.findIndex((row) => row.startsWith('message.')),
  );
  return { pages, rows, text: rows.join('\n'), raw };
}

test('vault transaction explains approval, identities, exact Quanta, operation, nonce and date', () => {
  const payload = vaultPayload();
  payload.message['value'] = '1234000000000000001';
  payload.message['nonce'] = VAULT_MAX_UINT256.toString();
  payload.message['validUntil'] = 1893456000;
  const request = recognizeVaultRequest(payload);
  assert.ok(request?.kind === 'VaultTx');
  const { text, pages, raw } = review(payload, 2);
  assert.ok(text.includes('Vault approval: Execute a vault transaction'));
  assert.ok(text.includes(`Vault address: ${groupQrlAddress(request.vault)}`));
  assert.ok(text.includes(`Vault destination: ${groupQrlAddress(request.tx.to)}`));
  assert.ok(text.includes('Vault value: 1.234000000000000001 Quanta'));
  assert.ok(text.includes('Vault operation: Call (0)'));
  assert.ok(text.includes(`Vault nonce: ${VAULT_MAX_UINT256.toString()}`));
  assert.ok(text.includes('2030-01-01T00:00:00.000Z'));
  assert.ok(
    text.includes(
      'Decoding assumes a genuine QuantaVault at verifyingContract. Main cannot verify that contract.',
    ),
  );
  assert.ok(
    unfoldDetail(pages[0] ?? '').includes(
      'WARNING: domain chainId differs from the wallet network.',
    ),
  );
  assert.equal(text.match(/WARNING: domain chainId/g)?.length, 1);
  assert.equal(raw.length, VAULT_TX_FIELDS.length);
});

test('validUntil has exact 30-day and maximum boundaries', (t) => {
  const now = Date.UTC(2026, 0, 1);
  t.mock.method(Date, 'now', () => now);
  for (const seconds of [
    0n,
    BigInt(now / 1000) + 30n * 86400n,
    BigInt(now / 1000) + 30n * 86400n + 1n,
    VAULT_MAX_UINT256,
  ]) {
    const payload = vaultPayload();
    payload.message['validUntil'] = seconds;
    const { text } = review(payload);
    assert.equal(text.includes('Maximum validUntil'), seconds === VAULT_MAX_UINT256);
    assert.equal(
      text.includes('more than 30 days away'),
      seconds > BigInt(now / 1000) + 30n * 86400n && seconds !== VAULT_MAX_UINT256,
    );
    if (seconds === VAULT_MAX_UINT256) assert.ok(text.includes('outside the supported date range'));
    if (seconds === 0n) assert.ok(text.includes('1970-01-01T00:00:00.000Z'));
  }
});

test('approval names both vaults and decodes the nested transaction', () => {
  const payload = vaultPayload('approval-empty');
  assert.ok(isRecord(payload.message['tx']));
  payload.message['tx']['data'] = vaultCalldata('changeThreshold').data;
  const recognized = recognizeVaultRequest(payload);
  assert.ok(recognized?.kind === 'VaultApproval');
  const { text, raw } = review(payload);
  assert.ok(text.includes(`Vault approving vault: ${groupQrlAddress(recognized.vault)}`));
  assert.ok(text.includes(`Vault outer vault: ${groupQrlAddress(recognized.outerVault)}`));
  assert.ok(text.includes('Vault calldata: changeThreshold'));
  assert.ok(
    text.includes(
      `Vault argument: _threshold (uint256): ${String(vaultCalldata('changeThreshold').values[0])}`,
    ),
  );
  assert.equal(raw.length, VAULT_TX_FIELDS.length + 1);
  assert.ok(raw[1]?.startsWith('message.tx.to'));
});

test('64-byte messages and opaque calldata approvals carry warnings', () => {
  for (const label of ['short-message', 'digest-message']) {
    const { text } = review(vaultPayload(label));
    assert.equal(text.includes('WARNING: Opaque digest/value.'), label === 'digest-message');
  }
  for (const method of ['approveHash', 'signMessage']) {
    const payload = vaultPayload();
    payload.message['data'] = vaultCalldata(method).data;
    const { text } = review(payload);
    assert.ok(text.includes(`Vault calldata: ${method}`));
    assert.ok(text.includes('WARNING: Opaque digest/value.'));
  }
});

test('administration, modules, simulation, roles and token transfers use marked payload rows', () => {
  for (const method of [
    'addOwnerWithThreshold',
    'removeOwner',
    'swapOwner',
    'changeThreshold',
    'setGuard',
    'setModuleGuard',
    'setFallbackHandler',
    'enableModule',
    'disableModule',
    'execTransactionFromModule',
    'execTransactionFromModuleReturnData',
    'simulateAndRevert',
    'grantRole',
    'revokeRole',
    'renounceRole',
    'updateDelay',
    'cancel',
    'transfer',
    'approve',
    'transferOwnership',
    'acceptOwnership',
    'renounceOwnership',
  ]) {
    const payload = vaultPayload();
    payload.message['data'] = vaultCalldata(method).data;
    const { text, pages } = review(payload);
    assert.ok(text.includes(method), method);
    assert.equal(text.includes('decoding omitted'), false, method);
    const rows = pages
      .flatMap((page) => page.split('\n'))
      .filter((row) => row.startsWith('\u200eVault '));
    assert.ok(rows.length > 0);
    assert.equal(
      pages.some((page) => /^Vault /m.test(page)),
      false,
    );
    if (
      [
        'execTransactionFromModule',
        'execTransactionFromModuleReturnData',
        'simulateAndRevert',
      ].includes(method)
    )
      assert.ok(text.includes('DelegateCall can change vault storage and move all vault funds.'));
    if (['transfer', 'approve'].includes(method)) {
      assert.ok(text.includes(`QRC-20 ${method}`));
      assert.ok(text.includes('base units'));
    }
    if (['grantRole', 'revokeRole', 'renounceRole'].includes(method))
      assert.ok(text.includes(`PROPOSER (${VAULT_ROLES.PROPOSER})`));
  }
});

test('timelock scheduling shows the scheduled ownership handoff', () => {
  for (const method of ['schedule', 'execute'] as const) {
    const payload = vaultPayload();
    payload.message['data'] = timelockVault.accept[method];
    const { text } = review(payload);
    assert.ok(text.includes(`Vault calldata: ${method}`));
    assert.ok(text.includes('Vault calldata: acceptOwnership'));
    assert.ok(text.includes(`Vault destination: ${groupQrlAddress(timelockVault.registrar)}`));
  }
});

test('five batch entries stay atomic and ordered through nine bounded pages', () => {
  const { pages, text } = review(vaultBatchPayload(5));
  assert.equal(text.includes('decoding omitted'), false);
  assert.ok(pages.length > 5);
  for (let index = 0; index < 5; index++) {
    const entry = `Vault entry: ${index + 1} of 5`;
    const page = pages.map(unfoldDetail).find((detail) => detail.includes(entry));
    assert.ok(page);
    assert.equal(pages.filter((detail) => unfoldDetail(detail).includes(entry)).length, 1);
    const entryRows = page.slice(page.indexOf(entry));
    assert.ok(
      entryRows.includes(
        `Vault destination: ${groupQrlAddress(
          `Q${BigInt(index + 1)
            .toString(16)
            .padStart(128, '0')}`,
        )}`,
      ),
    );
    assert.ok(entryRows.includes('Vault bytes: 0x'));
    assert.equal(entryRows.includes('Vault operation: DelegateCall (1)'), index % 3 === 0);
    if (index % 3 === 0) assert.ok(entryRows.includes('WARNING: DelegateCall'));
  }
});

test('long batches collapse explicitly with exact entry counts and all raw fields', () => {
  for (const count of [7, 50, 80]) {
    const { text, raw } = review(vaultBatchPayload(count));
    assert.ok(
      text.includes(
        `Vault summary: ${count} entries, decoding omitted, ${Math.ceil(count / 3)} DelegateCall entries`,
      ),
    );
    assert.equal(text.match(/Vault summary:/g)?.length, 1);
    assert.equal(text.includes('Vault entry:'), false);
    assert.ok(text.includes('WARNING: DelegateCall'));
    assert.ok(text.includes('Decoding assumes a genuine QuantaVault'));
    assert.equal(raw.length, VAULT_TX_FIELDS.length);
  }
});

test('a single oversized entry collapses explicitly and raw-size failures remain closed', () => {
  const payload = vaultPayload();
  payload.message['data'] = vaultCalldata('multiSend').data;
  // Long provenance reduces the available space for an indivisible entry.
  const request = SignatureRequestSchema.parse({
    ...typedRequest(payload),
    origin: { via: 'dapp', name: 'W'.repeat(64), url: '', channelId: 'abcdef01' },
  });
  const { pages } = summariseSignatureRequest(request);
  assert.ok(pages.map(unfoldDetail).join('\n').includes('decoding omitted'));
  for (const page of pages)
    assert.ok(typedDataDisplayLines(`${page}\n\n${SIGNATURE_APPROVAL_NOTE}`) <= 30);
  const tooLarge = payloadWith(
    'address[]',
    Array.from({ length: 256 }, () => vaultTestAddress),
  );
  tooLarge.domain['name'] = 'QuantaVault';
  assert.throws(
    () => summariseSignatureRequest(typedRequest(tooLarge)),
    /too large to review safely/,
  );
});

test('QuantaVault-named mismatches receive a warning and their raw review', () => {
  for (const alter of [
    (p: TypedDataPayload) => {
      p.domain['version'] = '2';
    },
    (p: TypedDataPayload) => {
      p.types['QRLDomain'] = [...(p.types['QRLDomain'] ?? []), { name: 'salt', type: 'bytes32' }];
      p.domain['salt'] = `0x${'00'.repeat(32)}`;
    },
    (p: TypedDataPayload) => {
      p.types['VaultTx'] = VAULT_TX_FIELDS.map((field) =>
        field.name === 'operation' ? { ...field, type: 'uint256' } : field,
      );
    },
  ]) {
    const payload = vaultPayload();
    alter(payload);
    const { text } = review(payload);
    assert.ok(text.includes('QuantaVault-named domain has an unrecognized schema'));
    assert.equal(text.includes('Vault approval:'), false);
  }
});

const signature: SignatureResult = {
  kind: 'typedData',
  signer: SIGNER,
  signature: '0x00',
  publicKey: '0x00',
  descriptor: '0x010000',
  digest: '0x00',
  schemeVersion: 'QRL-SIGN-TYPED-v2',
};

test('signWithConfirmation refuses each refund field before confirm and signer calls', async (t) => {
  const network = t.mock.method(globalThis, 'fetch', () => {
    throw new Error('unexpected network request');
  });
  for (const label of ['empty-call', 'approval-empty']) {
    for (const field of ['baseGas', 'gasPrice', 'gasToken', 'refundReceiver']) {
      for (const nonzero of field === 'gasToken' || field === 'refundReceiver'
        ? [vaultTestAddress]
        : [1, 1n, '1', '0x1']) {
        const payload = vaultPayload(label);
        const tx = label === 'empty-call' ? payload.message : payload.message['tx'];
        assert.ok(isRecord(tx));
        tx[field] = nonzero;
        const req = typedRequest(payload);
        const confirm = t.mock.fn(() => Promise.resolve(true));
        const sign = t.mock.fn(() => Promise.resolve(signature));
        const status = t.mock.fn(() =>
          Promise.resolve({ unlocked: true, address: SIGNER, unlockExpiresAt: null }),
        );
        await assert.rejects(
          signWithConfirmation(req, { confirm, signer: { status, sign } }),
          /QuantaVault refunds are unsupported/,
        );
        assert.equal(confirm.mock.callCount(), 0);
        assert.equal(sign.mock.callCount(), 0);
        assert.equal(status.mock.callCount(), 0);
        assert.throws(() => summariseSignatureRequest(req), /QuantaVault refunds are unsupported/);
        // The generic signer codec continues to accept structurally valid typed data.
        assert.equal(computeTypedDataDigest(payload).length, 64);
      }
    }
  }
  assert.equal(network.mock.callCount(), 0);
});

test('zero refunds and txGas reach confirmation; cancel and approval keep their handoff', async () => {
  for (const label of ['empty-call', 'approval-empty']) {
    for (const zero of [0, 0n, '0', '0x0', '-0', '-0x0']) {
      const payload = vaultPayload(label);
      const tx = label === 'empty-call' ? payload.message : payload.message['tx'];
      assert.ok(isRecord(tx));
      tx['baseGas'] = zero;
      tx['gasPrice'] = zero;
      tx['txGas'] = VAULT_MAX_UINT256;
      const req = typedRequest(payload);
      for (const approve of [true, false]) {
        const steps: string[] = [];
        const pending = signWithConfirmation(req, {
          signer: {
            status: () =>
              Promise.resolve({ unlocked: true, address: SIGNER, unlockExpiresAt: null }),
            sign: (received) => {
              assert.equal(received, req);
              steps.push('sign');
              return Promise.resolve(signature);
            },
          },
          confirm: (received) => {
            assert.equal(received, req);
            steps.push('confirm');
            return Promise.resolve(approve);
          },
        });
        if (approve) assert.equal(await pending, signature);
        else await assert.rejects(pending, /user rejected signature/);
        assert.deepEqual(steps, approve ? ['confirm', 'sign'] : ['confirm']);
      }
    }
  }
});
