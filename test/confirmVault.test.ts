import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { toChecksumAddress } from '@theqrl/wallet.js';
import {
  summariseSignatureRequest,
  typedDataDisplayLines,
  SIGNATURE_APPROVAL_NOTE,
} from '../src/main/confirmSummary';
import { groupQrlAddress } from '../src/shared/address';
import { vaultReview } from '../src/main/confirmVault';
import { VAULT_BATCH_METHODS } from '../src/shared/quantaVaultCalldata';
import { isRecord } from '../src/shared/guards';
import {
  recognizeVaultRequest,
  VAULT_MAX_UINT256,
  VAULT_TX_FIELDS,
} from '../src/shared/quantaVault';
import { VAULT_ROLES, VAULT_SELECTORS } from '../src/shared/quantaVaultSelectors';
import { signWithConfirmation } from '../src/main/signatureRequest';
import { computeTypedDataDigest } from '../src/signer/typedData';
import { assertDetailWidth, assertTrustedLineStarts, unfoldDetail } from './confirmLayout';
import {
  vaultBatchPayload,
  vaultCalldata,
  vaultPayload,
  vaultTestAddress,
  vaultReviewTime,
  vaultReviewVectors,
  vaultWord,
} from './quantaVaultFixtures';
import { typedRequest, SIGNER, payloadWith } from './typedDataFixtures';
import type { TypedDataPayload } from '../src/shared/typedData';
import { SignatureRequestSchema, type SignatureResult } from '../src/shared/schemas';
import timelockVault from './fixtures/quantaVault/timelock-vault.json';

const displayAddress = (value: string) => groupQrlAddress(toChecksumAddress(value));
beforeEach((t) => {
  assert.ok('mock' in t);
  t.mock.method(Date, 'now', () => Number(vaultReviewTime) * 1000);
});

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
  assert.ok(text.includes(`Vault address: ${displayAddress(request.vault)}`));
  assert.ok(text.includes(`Vault destination: ${displayAddress(request.tx.to)}`));
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
    BigInt(now / 1000) - 1n,
    BigInt(now / 1000),
    BigInt(now / 1000) + 1n,
    BigInt(now / 1000) + 30n * 86400n,
    BigInt(now / 1000) + 30n * 86400n + 1n,
    VAULT_MAX_UINT256,
  ]) {
    const payload = vaultPayload();
    payload.message['validUntil'] = seconds;
    const { text } = review(payload);
    assert.equal(
      text.includes('already expired and the vault will reject it'),
      seconds < BigInt(now / 1000),
    );
    assert.equal(text.includes('Maximum validUntil'), seconds === VAULT_MAX_UINT256);
    assert.equal(
      text.includes('more than 30 days away'),
      seconds > BigInt(now / 1000) + 30n * 86400n && seconds !== VAULT_MAX_UINT256,
    );
    if (seconds === VAULT_MAX_UINT256) assert.ok(text.includes('outside the supported date range'));
    if (seconds === 0n) assert.ok(text.includes('1970-01-01T00:00:00.000Z'));
  }
});

test('frontend review vectors preserve trusted warnings and effective targets', () => {
  for (const vector of vaultReviewVectors) {
    const payload = vaultPayload(vector.label);
    const { text } = review(payload);
    if (vector.label.includes('zero-target')) {
      const request = recognizeVaultRequest(payload);
      assert.ok(request && request.kind !== 'VaultMessage');
      const executingVault = request.kind === 'VaultApproval' ? request.outerVault : request.vault;
      const effectiveTarget = request.tx.operation === 1n ? executingVault : request.tx.to;
      const child = text.slice(text.indexOf('Vault entry:'));
      assert.ok(child.includes(`Vault destination: ${displayAddress(effectiveTarget)}`));
      assert.ok(child.includes('batch entry named the zero address'));
      assert.ok(child.includes('Vault calldata: changeThreshold'));
    }
    if (vector.label === 'scheduled-update-delay') {
      assert.ok(text.includes('Vault calldata: updateDelay'));
      assert.ok(text.includes('Vault argument: newDelay (uint256): 0'));
      assert.ok(
        text.includes('WARNING: This call changes ownership, roles or vault security settings.'),
      );
    }
    if (vector.label === 'revoke-zero-role')
      assert.equal(text.includes('opens it to everyone'), false);
    if (vector.label === 'unlimited-approve') {
      assert.ok(text.includes('WARNING: Unlimited QRC-20 allowance.'));
      assert.ok(text.includes(`${VAULT_MAX_UINT256} base units (QRC-20 amount or NFT token ID)`));
    }
    if (vector.label === 'invalid-operation') {
      assert.ok(text.includes('Vault operation: Invalid (2)'));
      assert.ok(text.includes('This transaction cannot execute.'));
      assert.equal(text.includes('Invalid calldata'), false);
    }
    if (vector.label === 'expired-validity' || vector.label === 'zero-validity')
      assert.ok(text.includes('already expired and the vault will reject it'));
  }
});

test('nonzero txGas warning stays with its decoded row for both approval kinds', () => {
  for (const label of ['empty-call', 'approval-empty']) {
    for (const gas of [0n, 1n, 10000n, VAULT_MAX_UINT256]) {
      const payload = vaultPayload(label);
      const tx = label === 'empty-call' ? payload.message : payload.message['tx'];
      assert.ok(isRecord(tx));
      tx['txGas'] = gas;
      const { pages, text } = review(payload);
      assert.equal(text.includes('WARNING: txGas is nonzero.'), gas !== 0n);
      const page = pages.map(unfoldDetail).find((page) => page.includes(`Vault txGas: ${gas}`));
      assert.ok(page);
      if (gas !== 0n) {
        assert.ok(page.includes(`Vault txGas: ${gas}\nWARNING: txGas is nonzero.`));
        assert.ok(page.includes('failed inner call can complete and spend the nonce'));
        assert.ok(page.includes('anyone executing can supply just enough gas'));
      }
    }
  }
});

test('operation and malformed-calldata warnings appear once on trusted rows', () => {
  const payload = vaultPayload('invalid-operation');
  payload.message['data'] = vaultCalldata('approve').data.slice(0, -2);
  const { text } = review(payload);
  assert.equal(text.match(/WARNING: Invalid calldata/g)?.length, 1);
  assert.equal(text.match(/WARNING: The vault rejects/g)?.length, 1);
});

test('unknown and depth-limited calls direct full calldata verification to the app', () => {
  const unknown = vaultPayload();
  unknown.message['data'] = `0xdeadbeef${'12'.repeat(100)}`;
  const nested = vaultPayload();
  const data = vaultCalldata('schedule').data;
  const packed = `00${vaultTestAddress.slice(1)}${vaultWord(0n)}${vaultWord(BigInt((data.length - 2) / 2))}${data.slice(2)}`;
  nested.message['data'] =
    vaultCalldata('multiSend').selector +
    vaultWord(64n) +
    vaultWord(BigInt(packed.length / 2)) +
    packed.padEnd(Math.ceil(packed.length / 128) * 128, '0');
  for (const [payload, warning] of [
    [unknown, 'Unknown calldata'],
    [nested, 'Deeper calls are unexpanded'],
  ] as const) {
    const { text } = review(payload);
    assert.ok(
      text.includes(
        `WARNING: ${warning}. This window shows only the first bytes. Verify the full calldata in the QuantaVault app before approving.`,
      ),
    );
  }
});

test('approve and transferFrom keep the QRC-20 and NFT selector ambiguity visible', () => {
  for (const method of ['approve', 'transferFrom']) {
    const payload = vaultPayload();
    payload.message['data'] = vaultCalldata(method).data;
    const { text } = review(payload);
    assert.ok(text.includes(`Vault calldata: ${method}`));
    assert.ok(text.includes('base units (QRC-20 amount or NFT token ID)'));
    assert.equal(text.includes('destination/token'), false);
    assert.equal(text.includes(`QRC-20 ${method}`), false);
  }
});

test('single-child methods show child arguments once and retain all other arguments', () => {
  const childFields = new Set([
    'to',
    'target',
    'targetContract',
    'value',
    'data',
    'payload',
    'calldataPayload',
    'operation',
  ]);
  for (const method of [
    'execTransaction',
    'execTransactionFromModule',
    'execTransactionFromModuleReturnData',
    'schedule',
    'execute',
    'simulateAndRevert',
  ]) {
    const payload = vaultPayload();
    const fixture = vaultCalldata(method);
    // Numeric addresses keep the complete child within one native page.
    payload.message['data'] = fixture.data
      .replaceAll('cd'.repeat(64), '11'.repeat(64))
      .replaceAll('ab'.repeat(64), '22'.repeat(64));
    const { text } = review(payload);
    const index = text.indexOf('Vault entry: 1 of 1');
    assert.ok(index > 0, method);
    const top = text.slice(0, index);
    for (const { name } of VAULT_SELECTORS.find((entry) => entry.name === method)?.inputs ?? [])
      assert.equal(
        top.includes(`Vault argument: ${name} (`),
        !childFields.has(name),
        `${method}.${name}`,
      );
    for (const label of ['destination', 'value', 'operation', 'calldata'])
      assert.equal(
        text.slice(index).match(new RegExp(`Vault ${label}:`, 'g'))?.length,
        1,
        `${method}.${label}`,
      );
  }
});

test('all shared batch methods group child arguments and retain scheduling metadata', () => {
  for (const method of VAULT_BATCH_METHODS) {
    const payload = vaultPayload();
    payload.message['data'] = vaultCalldata(method).data;
    const decoded = vaultReview(payload, { quanta: String, bytes: (value) => value });
    assert.ok(decoded?.collapse);
    const values = decoded
      .collapse()
      .flat()
      .flatMap((row) => ('value' in row ? [row.value] : []));
    for (const { name } of VAULT_SELECTORS.find((entry) => entry.name === method)?.inputs ?? []) {
      assert.equal(
        values.some((value) => value.startsWith(`${name} (`)),
        !['transactions', 'targets', 'values', 'payloads'].includes(name),
        `${method}.${name}`,
      );
    }
    assert.ok(
      decoded.groups.some((group) =>
        group.some((row) => 'label' in row && row.label === 'Vault entry:'),
      ),
    );
  }
});

test('every decoded address uses wallet.js QIP-55 casing while raw payloads retain their case', () => {
  for (const method of [
    'addOwnerWithThreshold',
    'execTransaction',
    'schedule',
    'scheduleBatch',
    'executeBatch',
    'transferFrom',
  ]) {
    const payload = vaultPayload();
    payload.domain['verifyingContract'] = vaultTestAddress;
    payload.message['to'] = `Q${vaultTestAddress.slice(1).toUpperCase()}`;
    payload.message['data'] = vaultCalldata(method).data;
    const { rows, raw } = review(payload);
    const decoded = rows.filter((row) => row.startsWith('Vault ')).join('\n');
    const addresses = [...decoded.matchAll(/Q[0-9a-fA-F]{8}(?: [0-9a-fA-F]{8}){15}/g)];
    assert.ok(addresses.length >= 2, method);
    for (const [address] of addresses) {
      const ungrouped = address.replaceAll(' ', '');
      assert.equal(ungrouped, toChecksumAddress(ungrouped), method);
    }
    assert.ok(raw[0]?.includes(groupQrlAddress(String(payload.message['to']))));
  }
});

test('decoded byte previews match raw typed-data previews at every truncation boundary', () => {
  for (const size of [0, 1, 30, 31, 32, 33, 64, 65, 1000]) {
    const bytes = `0x${'cd'.repeat(size)}`;
    for (const label of ['empty-call', 'empty-message']) {
      const payload = vaultPayload(label);
      const field = label === 'empty-call' ? 'data' : 'message';
      payload.message[field] = bytes;
      const { rows } = review(payload);
      const decodedLabel = label === 'empty-call' ? 'Vault bytes: ' : 'Vault message: ';
      const rawLabel = `message.${field} (bytes): `;
      assert.equal(
        rows.find((row) => row.startsWith(decodedLabel))?.slice(decodedLabel.length),
        rows.find((row) => row.startsWith(rawLabel))?.slice(rawLabel.length),
      );
    }
  }
  const payload = vaultPayload();
  const fixture = vaultCalldata('approveHash');
  payload.message['data'] = fixture.data;
  const { rows } = review(payload);
  const message = vaultPayload('empty-message');
  message.message['message'] = fixture.values[0];
  const expected = review(message).raw[0]?.split('(bytes): ')[1];
  assert.equal(
    rows.find((row) => row.startsWith('Vault argument:'))?.split('(bytes64): ')[1],
    expected,
  );
});

test('approval names both vaults and decodes the nested transaction', () => {
  const payload = vaultPayload('approval-empty');
  assert.ok(isRecord(payload.message['tx']));
  payload.message['tx']['data'] = vaultCalldata('changeThreshold').data;
  const recognized = recognizeVaultRequest(payload);
  assert.ok(recognized?.kind === 'VaultApproval');
  const { text, raw } = review(payload);
  assert.ok(text.includes(`Vault approving vault: ${displayAddress(recognized.vault)}`));
  assert.ok(text.includes(`Vault outer vault: ${displayAddress(recognized.outerVault)}`));
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
      assert.ok(
        text.includes(`Vault calldata: ${method === 'transfer' ? 'QRC-20 transfer' : method}`),
      );
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
    assert.ok(text.includes(`Vault destination: ${displayAddress(timelockVault.registrar)}`));
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
        `Vault destination: ${displayAddress(
          `Q${BigInt(index + 1)
            .toString(16)
            .padStart(128, '0')}`,
        )}`,
      ),
    );
    assert.ok(entryRows.includes('Vault bytes: "0x"'));
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

test('collapse preserves every top-level row and all warnings for both approval kinds', () => {
  const format = { quanta: String, bytes: (value: string) => value };
  for (const label of ['empty-call', 'approval-empty']) {
    const payload = vaultPayload(label);
    const tx = {
      ...vaultBatchPayload(50).message,
      operation: 2,
      txGas: 10000,
      validUntil: vaultReviewTime - 1n,
    };
    if (label === 'empty-call') payload.message = tx;
    else payload.message['tx'] = tx;
    const decoded = vaultReview(payload, format);
    assert.ok(decoded?.collapse);
    const topLevel = decoded.groups.slice(
      0,
      decoded.groups.findIndex((group) =>
        group.some((row) => 'label' in row && row.label === 'Vault entry:'),
      ),
    );
    const reduced = decoded.collapse();
    assert.deepEqual(reduced.slice(0, topLevel.length), topLevel);
    const warnings = (groups: typeof reduced) =>
      new Set(groups.flat().flatMap((row) => ('warning' in row ? [row.warning] : [])));
    assert.deepEqual(warnings(reduced), warnings(decoded.groups));
    const { text, raw } = review(payload);
    for (const field of [
      'approval',
      label === 'empty-call' ? 'address' : 'approving vault',
      'destination',
      'value',
      'operation',
      'calldata',
      'nonce',
      'validUntil',
      'txGas',
    ])
      assert.ok(text.includes(`Vault ${field}:`), field);
    if (label === 'approval-empty') assert.ok(text.includes('Vault outer vault:'));
    assert.ok(text.includes('Vault operation: Invalid (2)'));
    assert.ok(
      text.includes('Vault summary: 50 entries, decoding omitted, 17 DelegateCall entries'),
    );
    assert.equal(text.includes('Vault entry:'), false);
    assert.ok(text.includes('WARNING: txGas is nonzero.'));
    assert.ok(text.includes('already expired and the vault will reject it'));
    assert.ok(text.includes('This transaction cannot execute.'));
    assert.equal(raw.length, VAULT_TX_FIELDS.length + (label === 'approval-empty' ? 1 : 0));
  }
  for (const label of ['scheduled-update-delay', 'tx-zero-target-delegatecall']) {
    const decoded = vaultReview(vaultPayload(label), format);
    assert.ok(decoded?.collapse);
    const reduced = decoded.collapse().flat();
    assert.ok(reduced.some((row) => 'warning' in row && row.warning.includes('security settings')));
    if (label.includes('zero-target'))
      assert.ok(
        reduced.some(
          (row) => 'warning' in row && row.warning.includes('batch entry named the zero address'),
        ),
      );
  }
});

test('messages and calls without children never produce an entry count', () => {
  for (const label of ['empty-message', 'digest-message', 'empty-call', 'unlimited-approve']) {
    const payload = vaultPayload(label);
    const decoded = vaultReview(payload, { quanta: String, bytes: (value) => value });
    assert.equal(decoded?.collapse, undefined);
    const { text } = review(payload);
    assert.equal(text.includes('entries'), false);
    assert.equal(text.includes('Vault summary:'), false);
  }
});

test('a pagination retry reuses raw rows already generated before overflow', () => {
  let retriedAfterRaw = false;
  for (let count = 4; count <= 8; count++) {
    const request = typedRequest(vaultBatchPayload(count));
    assert.ok(request.kind === 'typedData');
    const original = request.payload.message['to'];
    let reads = 0;
    Object.defineProperty(request.payload.message, 'to', {
      enumerable: true,
      get: () => {
        reads++;
        return original;
      },
    });
    const pages = summariseSignatureRequest(request).pages;
    assert.equal(reads, 2, 'one recognizer read and one raw-row read');
    if (pages.some((page) => unfoldDetail(page).includes('decoding omitted')) && count === 6)
      retriedAfterRaw = true;
  }
  assert.ok(retriedAfterRaw);
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
