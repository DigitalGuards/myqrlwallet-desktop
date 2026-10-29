import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QRL_ZERO_ADDRESS } from '../src/shared/address';
import { keccak_256, shake256 } from '@noble/hashes/sha3.js';
import { computeTypedDataDigest, typeHash, typedDataSchemeTag } from '../src/signer/typedData';
import { encodeType, typedDataSchemeVersion } from '../src/shared/typedData';
import { TypedDataPayloadSchema } from '../src/shared/schemas';
import {
  recognizeVaultRequest,
  vaultApprovalBlocked,
  vaultUint,
  VAULT_TX_FIELDS,
  VAULT_MAX_UINT256,
} from '../src/shared/quantaVault';
import {
  decodeVaultAbi,
  decodeVaultCall,
  decodeVaultMultiSend,
  vaultRoleLabel,
  type VaultAbiType,
  type VaultAbiValue,
} from '../src/shared/quantaVaultCalldata';
import { QUANTA_VAULT_CONFIG } from '../src/shared/quantaVaultConfig';
import { VAULT_SELECTORS, VAULT_ROLES } from '../src/shared/quantaVaultSelectors';
import {
  vaultCalldata,
  vaultPayload,
  vaultSchemeVectors,
  vaultReviewVectors,
  vaultTestAddress,
  vaultWord,
} from './quantaVaultFixtures';
import batchVectors from './fixtures/quantaVault/multi-send.json';
import calldataVectors from './fixtures/quantaVault/calldata.json';
import selectors from './fixtures/quantaVault/selectors.json';
import nested from './fixtures/quantaVault/nested-vaults.json';
import proposals from './fixtures/quantaVault/proposals.json';
import timelock from './fixtures/quantaVault/timelock.json';
import timelockVault from './fixtures/quantaVault/timelock-vault.json';

const hex = (value: Uint8Array): string => `0x${Buffer.from(value).toString('hex')}`;
const bytes = (value: string): Buffer => Buffer.from(value.slice(2), 'hex');
function reviewCall(label: string) {
  const request = recognizeVaultRequest(vaultPayload(label));
  assert.ok(request && request.kind !== 'VaultMessage');
  return decodeVaultCall(
    request.tx,
    request.chainId,
    request.kind === 'VaultApproval' ? request.outerVault : request.vault,
  );
}
function normalized(value: VaultAbiValue): unknown {
  if (typeof value === 'bigint') return value.toString();
  return typeof value === 'string' ? value : value.map(normalized);
}
const call = (data: string, operation = 0n, to = vaultTestAddress) => ({
  to,
  value: 0n,
  data,
  operation,
});
function replaceWord(data: string, index: number, value: bigint): string {
  const start = 10 + index * 128;
  return data.slice(0, start) + vaultWord(value) + data.slice(start + 128);
}

for (const vector of vaultSchemeVectors) {
  test(`vault typed-data parity: ${vector.label}`, () => {
    const payload = vaultPayload(vector.label);
    assert.equal(recognizeVaultRequest(payload)?.kind, payload.primaryType);
    const scheme = typedDataSchemeVersion(payload);
    assert.equal(scheme, vector.schemeVersion);
    assert.equal(encodeType(payload.primaryType, payload.types), vector.encodeTypeString);
    assert.equal(hex(typeHash(payload.primaryType, payload.types)), vector.typeHashHex);
    assert.equal(hex(computeTypedDataDigest(payload)), vector.digestHex);
    assert.equal(
      hex(
        shake256(
          Buffer.concat([
            typedDataSchemeTag(scheme),
            bytes(vector.domainHashHex),
            bytes(vector.messageHashHex),
          ]),
          { dkLen: 64 },
        ),
      ),
      vector.digestHex,
    );
  });
}

for (const vector of vaultReviewVectors) {
  test(`vault review digest and policy parity: ${vector.label}`, () => {
    const payload = vaultPayload(vector.label);
    assert.equal(recognizeVaultRequest(payload)?.kind, payload.primaryType);
    assert.equal(hex(computeTypedDataDigest(payload)), vector.digestHex);
    assert.equal(vaultApprovalBlocked(payload), false);
  });
}

test('zero batch targets resolve to the executing contract for both approval kinds and operations', () => {
  for (const kind of ['tx', 'approval']) {
    for (const operation of ['call', 'delegatecall']) {
      const label = `${kind}-zero-target-${operation}`;
      const request = recognizeVaultRequest(vaultPayload(label));
      assert.ok(request && request.kind !== 'VaultMessage');
      const executingVault = request.kind === 'VaultApproval' ? request.outerVault : request.vault;
      const children = reviewCall(label).children;
      assert.equal(children.length, 1);
      assert.equal(children[0]?.to, operation === 'call' ? request.tx.to : executingVault);
      assert.equal(children[0].batchTarget, QRL_ZERO_ADDRESS);
      assert.equal(children[0].method, 'changeThreshold');
      assert.deepEqual(children[0].args, [{ name: '_threshold', type: 'uint256', value: 2n }]);
      assert.deepEqual(children[0].warnings, ['securityChange']);
    }
  }
});

test('scheduled updateDelay, revoked zero role, unlimited approve and invalid operation match review vectors', () => {
  const scheduled = reviewCall('scheduled-update-delay');
  assert.equal(scheduled.method, 'schedule');
  assert.equal(scheduled.children[0]?.method, 'updateDelay');
  assert.deepEqual(scheduled.children[0].args, [{ name: 'newDelay', type: 'uint256', value: 0n }]);
  assert.deepEqual(scheduled.children[0].warnings, ['securityChange']);
  assert.deepEqual(reviewCall('revoke-zero-role').warnings, ['securityChange']);
  const unlimited = reviewCall('unlimited-approve');
  assert.equal(unlimited.method, 'approve');
  assert.deepEqual(unlimited.warnings, ['unlimitedAllowance']);
  assert.equal(unlimited.args[0]?.value, `Q${'66'.repeat(64)}`);
  assert.equal(unlimited.args[1]?.value, VAULT_MAX_UINT256);
  assert.deepEqual(
    decodeVaultCall(
      call(replaceWord(vaultCalldata('approve').data, 1, VAULT_MAX_UINT256 - 1n)),
      1n,
      vaultTestAddress,
    ).warnings,
    [],
  );
  const invalid = reviewCall('invalid-operation');
  assert.equal(invalid.status, 'decoded');
  assert.equal(invalid.method, 'approve');
  assert.equal(invalid.operation, 2n);
  assert.deepEqual(invalid.warnings, ['invalidOperation']);
  assert.equal(invalid.args[1]?.value, 1234500n);
});

test('operation errors stay distinct on every calldata path and repeated warnings are deduplicated', () => {
  for (const [data, status, warnings] of [
    ['0x', 'empty', ['invalidOperation']],
    ['0xdeadbeef', 'unknown', ['invalidOperation', 'unknownCalldata']],
    [vaultCalldata('approve').data, 'decoded', ['invalidOperation']],
    [
      vaultCalldata('approve').data.slice(0, -2),
      'invalid',
      ['invalidOperation', 'invalidCalldata'],
    ],
  ] as const) {
    const decoded = decodeVaultCall(call(data, 2n), 1n, vaultTestAddress);
    assert.equal(decoded.status, status);
    assert.deepEqual(decoded.warnings, warnings);
  }
  assert.deepEqual(
    decodeVaultCall(call(vaultCalldata('simulateAndRevert').data, 1n), 1n, vaultTestAddress)
      .warnings,
    ['delegateCall'],
  );
  assert.deepEqual(
    decodeVaultCall(
      call(vaultCalldata('simulateAndRevert').data, 1n),
      1n,
      vaultTestAddress,
      QUANTA_VAULT_CONFIG,
      1,
    ).warnings,
    ['delegateCall', 'depthLimit'],
  );
});

test('nested vault opaque message retains identity and digest', () => {
  const payload = TypedDataPayloadSchema.parse(nested.messagePayload);
  assert.deepEqual(recognizeVaultRequest(payload), {
    kind: 'VaultMessage',
    vault: nested.inner,
    chainId: 1n,
    message: nested.outerDigest,
  });
  assert.equal(hex(computeTypedDataDigest(payload)), nested.messageDigest);
});

for (const vector of batchVectors.batches) {
  test(`packed batch parity: ${vector.label}`, () => {
    assert.deepEqual(
      decodeVaultMultiSend(vector.encoded).map((entry) => ({
        ...entry,
        value: entry.value.toString(),
        operation: Number(entry.operation),
      })),
      vector.transactions,
    );
  });
}

test('every precomputed selector and role matches its signature and fixture', () => {
  for (const definition of VAULT_SELECTORS) {
    const signature = `${definition.name}(${definition.inputs.map((input) => input.type).join(',')})`;
    assert.equal(
      hex(keccak_256(new TextEncoder().encode(signature)).slice(0, 4)),
      definition.selector,
    );
    assert.ok(selectors.selectors.some((vector) => vector.signature === signature));
  }
  for (const vector of selectors.selectors) {
    const definition = VAULT_SELECTORS.find((entry) => entry.selector === vector.selector);
    assert.ok(definition);
    assert.equal(definition.name, vector.name);
    assert.deepEqual(
      definition.inputs.map((input) => input.type),
      vector.inputs.map((input) => input.type),
    );
  }
  for (const [name, hash] of Object.entries(VAULT_ROLES)) {
    assert.equal(vaultRoleLabel(hash), name);
    assert.equal(
      name === 'DEFAULT_ADMIN'
        ? `0x${'00'.repeat(32)}`
        : hex(keccak_256(new TextEncoder().encode(`${name}_ROLE`))),
      hash,
    );
  }
});

for (const vector of calldataVectors) {
  test(`calldata argument parity: ${vector.method}`, () => {
    const decoded = decodeVaultCall(call(vector.data), 1n, vaultTestAddress);
    assert.equal(decoded.status, 'decoded');
    assert.equal(decoded.method, vector.method);
    assert.deepEqual(
      decoded.args.map((arg) => arg.type),
      vector.types,
    );
    assert.deepEqual(
      decoded.args.map((arg) => normalized(arg.value)),
      vector.values,
    );
  });
}

for (const { label, tx, event } of proposals.proposals) {
  test(`proposal ABI parity: ${label}`, () => {
    const types: VaultAbiType[] = [
      'address',
      'uint256',
      'bytes',
      'uint8',
      'uint256',
      'uint256',
      'uint256',
      'address',
      'address',
      'uint256',
      'uint256',
    ];
    assert.deepEqual(decodeVaultAbi(types, event.data).map(normalized), [
      tx.to,
      tx.value,
      tx.data,
      String(tx.operation),
      tx.safeTxGas,
      tx.baseGas,
      tx.gasPrice,
      tx.gasToken,
      tx.refundReceiver,
      tx.nonce,
      tx.validUntil,
    ]);
  });
}
for (const vector of timelock.singles) {
  test(`timelock ABI parity: ${vector.label}`, () => {
    assert.deepEqual(
      decodeVaultAbi(['address', 'uint256', 'bytes', 'bytes32', 'bytes32'], vector.encoding).map(
        normalized,
      ),
      [vector.target, vector.value, vector.data, vector.predecessor, vector.salt],
    );
  });
}
for (const vector of timelock.batches) {
  test(`timelock array parity: ${vector.label}`, () => {
    assert.deepEqual(
      decodeVaultAbi(
        ['address[]', 'uint256[]', 'bytes[]', 'bytes32', 'bytes32'],
        vector.encoding,
      ).map(normalized),
      [vector.targets, vector.values, vector.payloads, vector.predecessor, vector.salt],
    );
  });
}
test('scheduled ownership handoffs expand', () => {
  for (const method of ['schedule', 'execute'] as const) {
    const decoded = decodeVaultCall(call(timelockVault.accept[method]), 1n, vaultTestAddress);
    assert.equal(decoded.children.length, 1);
    assert.equal(decoded.children[0]?.to, timelockVault.registrar);
    assert.equal(decoded.children[0].method, 'acceptOwnership');
    assert.deepEqual(decoded.children[0].warnings, ['securityChange']);
  }
});

test('recognition checks every domain, tx, message and approval field and exact type set', () => {
  for (const label of ['empty-call', 'approval-empty', 'empty-message']) {
    const original = vaultPayload(label);
    for (const [name, fields] of Object.entries(original.types)) {
      for (const [index, field] of fields.entries()) {
        for (const change of [
          { ...field, name: `${field.name}Changed` },
          { ...field, type: `${field.type}[]` },
          fields[(index + 1) % fields.length],
        ]) {
          if (!change || change === field) continue;
          const payload = vaultPayload(label);
          payload.types[name] = fields.map((entry, i) => (i === index ? change : entry));
          assert.equal(recognizeVaultRequest(payload), null);
        }
      }
      for (const replacement of [
        fields.slice(1),
        [...fields, { name: 'extra', type: 'uint256' }],
      ]) {
        const payload = vaultPayload(label);
        payload.types[name] = replacement;
        assert.equal(recognizeVaultRequest(payload), null);
      }
    }
    for (const mutate of [
      (p: typeof original) => {
        p.domain['version'] = '2';
      },
      (p: typeof original) => {
        p.domain['salt'] = '0x00';
      },
      (p: typeof original) => {
        p.domain['name'] = 'Other';
      },
      (p: typeof original) => {
        p.types['Unused'] = VAULT_TX_FIELDS;
      },
      (p: typeof original) => {
        p.primaryType = 'Other';
      },
      (p: typeof original) => {
        p.message['extra'] = 0;
      },
      (p: typeof original) => {
        delete p.domain['chainId'];
      },
      (p: typeof original) => {
        p.domain['verifyingContract'] = 'invalid';
      },
    ]) {
      const payload = vaultPayload(label);
      mutate(payload);
      assert.equal(recognizeVaultRequest(payload), null);
    }
  }
});

test('refund policy covers all direct and nested fields and exact integer encodings', () => {
  for (const label of ['empty-call', 'approval-empty']) {
    for (const field of ['baseGas', 'gasPrice', 'gasToken', 'refundReceiver']) {
      const payload = vaultPayload(label);
      const request = recognizeVaultRequest(payload);
      assert.ok(request && request.kind !== 'VaultMessage');
      const tx = {
        ...request.tx,
        [field]: field === 'gasToken' || field === 'refundReceiver' ? vaultTestAddress : '0x1',
      };
      if (label === 'empty-call') payload.message = tx;
      else payload.message['tx'] = tx;
      assert.equal(vaultApprovalBlocked(payload), true);
    }
  }
  for (const value of [0, 0n, '0', '0x0', '-0', '-0x0']) assert.equal(vaultUint(value), 0n);
  for (const value of [
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    ' 0',
    '01',
    true,
    VAULT_MAX_UINT256 + 1n,
  ])
    assert.throws(() => vaultUint(value));
  const payload = vaultPayload();
  payload.message['txGas'] = VAULT_MAX_UINT256;
  assert.equal(vaultApprovalBlocked(payload), false);
});

test('security, opaque approvals, module execution, simulation and open roles warn', () => {
  for (const method of [
    'addOwnerWithThreshold',
    'removeOwner',
    'swapOwner',
    'changeThreshold',
    'enableModule',
    'disableModule',
    'setGuard',
    'setModuleGuard',
    'setFallbackHandler',
    'transferOwnership',
    'acceptOwnership',
    'renounceOwnership',
    'grantRole',
    'revokeRole',
    'renounceRole',
    'updateDelay',
  ])
    assert.ok(
      decodeVaultCall(call(vaultCalldata(method).data), 1n, vaultTestAddress).warnings.includes(
        'securityChange',
      ),
    );
  for (const method of ['approveHash', 'signMessage'])
    assert.ok(
      decodeVaultCall(call(vaultCalldata(method).data), 1n, vaultTestAddress).warnings.includes(
        'opaqueApproval',
      ),
    );
  assert.ok(
    decodeVaultCall(
      call(vaultCalldata('simulateAndRevert').data),
      1n,
      vaultTestAddress,
    ).warnings.includes('delegateCall'),
  );
  for (const method of [
    'execTransaction',
    'execTransactionFromModule',
    'execTransactionFromModuleReturnData',
  ])
    assert.ok(
      decodeVaultCall(
        call(vaultCalldata(method).data),
        1n,
        vaultTestAddress,
      ).children[0]?.warnings.includes('delegateCall'),
    );
  for (const method of ['grantRole', 'revokeRole', 'renounceRole'])
    assert.deepEqual(
      decodeVaultCall(call(replaceWord(vaultCalldata(method).data, 1, 0n)), 1n, vaultTestAddress)
        .warnings,
      method === 'grantRole' ? ['securityChange', 'openRole'] : ['securityChange'],
    );
});

test('only a pinned chain-specific call-only target suppresses the outer DelegateCall warning', () => {
  const data = vaultCalldata('multiSend').data;
  const config = { multiSendCallOnly: { '1': [vaultTestAddress] } };
  assert.ok(
    decodeVaultCall(call(data, 1n), 1n, vaultTestAddress).warnings.includes('delegateCall'),
  );
  const pinned = decodeVaultCall(call(data, 1n), 1n, vaultTestAddress, config);
  assert.equal(pinned.warnings.includes('delegateCall'), false);
  assert.ok(pinned.children[1]?.warnings.includes('delegateCall'));
  for (const decoded of [
    decodeVaultCall(call(data, 1n), 2n, vaultTestAddress, config),
    decodeVaultCall(call(data, 1n, nested.outer), 1n, vaultTestAddress, config),
    decodeVaultCall(call(vaultCalldata('signMessage').data, 1n), 1n, vaultTestAddress, config),
    decodeVaultCall(call(data, 1n), 1n, vaultTestAddress, config, 1),
  ])
    assert.ok(decoded.warnings.includes('delegateCall'));
});

test('unknown bytes and depth limits retain their bytes and warnings', () => {
  const unknown = decodeVaultCall(call('0xdeadbeef1234', 1n), 1n, vaultTestAddress);
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.data, '0xdeadbeef1234');
  assert.deepEqual(unknown.warnings, ['delegateCall', 'unknownCalldata']);
  const decoded = decodeVaultCall(
    call(vaultCalldata('schedule').data),
    1n,
    vaultTestAddress,
    QUANTA_VAULT_CONFIG,
    1,
  );
  assert.deepEqual(decoded.children, []);
  assert.ok(decoded.warnings.includes('depthLimit'));
  assert.equal(
    decoded.args.find((arg) => arg.name === 'data')?.value,
    vaultCalldata('transferOwnership').selector + vaultTestAddress.slice(1),
  );
  assert.ok(
    decodeVaultCall(
      call(vaultCalldata('multiSend').data),
      1n,
      vaultTestAddress,
      QUANTA_VAULT_CONFIG,
      1,
    ).warnings.includes('delegateCall'),
  );
});

test('malformed QRVM ABI fails closed without partial decoding', () => {
  const data = vaultCalldata('signMessage').data;
  for (const malformed of [
    data.slice(0, -2),
    data + '00',
    replaceWord(data, 0, 0n),
    replaceWord(data, 0, 65n),
    replaceWord(data, 0, 1n << 511n),
    replaceWord(data, 1, 1n << 511n),
    replaceWord(data, 1, 63n),
  ]) {
    const decoded = decodeVaultCall(call(malformed), 1n, vaultTestAddress);
    assert.equal(decoded.status, 'invalid');
    assert.equal(decoded.data, malformed);
    assert.deepEqual(decoded.args, []);
    assert.deepEqual(decoded.children, []);
    assert.deepEqual(decoded.warnings, ['invalidCalldata']);
  }
  for (const malformed of [
    replaceWord(vaultCalldata('transfer').data, 1, 1n << 256n),
    replaceWord(vaultCalldata('execTransactionFromModule').data, 3, 256n),
    replaceWord(vaultCalldata('cancel').data, 0, 1n),
  ])
    assert.equal(decodeVaultCall(call(malformed), 1n, vaultTestAddress).status, 'invalid');
  const unequal = timelock.batches.find((entry) => entry.label === 'unequal-hash-inputs');
  assert.ok(unequal);
  assert.equal(
    decodeVaultCall(
      call(vaultCalldata('executeBatch').selector + unequal.encoding.slice(2)),
      1n,
      vaultTestAddress,
    ).status,
    'invalid',
  );
  for (let size = 1; size < 193; size++)
    assert.throws(() => decodeVaultMultiSend(`0x${'00'.repeat(size)}`));
  const entry = `00${vaultTestAddress.slice(1)}${vaultWord(0n)}`;
  for (const malformed of [
    `0x${entry}${vaultWord(2n)}ff`,
    `0x${entry}${vaultWord(1n << 511n)}`,
    `0x02${entry.slice(2)}${vaultWord(0n)}`,
  ])
    assert.throws(() => decodeVaultMultiSend(malformed));
});
