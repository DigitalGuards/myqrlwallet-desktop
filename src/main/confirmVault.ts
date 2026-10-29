/** Payload-only QuantaVault review. Every value row is dApp-sourced by the caller. */
import { groupQrlAddress } from '../shared/address';
import { hasVaultRefund, recognizeVaultRequest, VAULT_MAX_UINT256 } from '../shared/quantaVault';
import {
  decodeVaultCall,
  vaultRoleLabel,
  type DecodedVaultCall,
  type VaultAbiValue,
  type VaultCallWarning,
} from '../shared/quantaVaultCalldata';
import type { TypedDataPayload } from '../shared/typedData';

export type VaultReviewRow = { label: string; value: string } | { warning: string };
export interface VaultReview {
  /** A batch entry is one indivisible group. Other rows can page individually. */
  groups: VaultReviewRow[][];
  /** One explicit count row, retaining every trusted warning. */
  collapsed: VaultReviewRow[][];
}

interface VaultFormat {
  quanta: (value: bigint) => string;
  bytes: (value: string) => string;
}

const ASSUMPTION =
  'NOTE: Decoding assumes a genuine QuantaVault at verifyingContract. Main cannot verify that contract.';
const WARNINGS: Record<VaultCallWarning, string> = {
  delegateCall: 'WARNING: DelegateCall can change vault storage and move all vault funds.',
  securityChange: 'WARNING: This call changes ownership, roles or vault security settings.',
  opaqueApproval:
    'WARNING: Opaque digest/value. Its meaning cannot be verified; it may authorize another action.',
  openRole: 'WARNING: The zero address can open a timelock role to everyone.',
  depthLimit: 'WARNING: Deeper calls are unexpanded. Review their bytes.',
  unknownCalldata: 'WARNING: Unknown calldata. Review the raw bytes.',
  invalidCalldata: 'WARNING: Invalid calldata. Decoding unavailable.',
};

const valueRow = (label: string, value: string): VaultReviewRow => ({
  label: `Vault ${label}:`,
  value,
});
const warning = (text: string): VaultReviewRow => ({ warning: text });

function operation(value: bigint): string {
  return value === 0n
    ? 'Call (0)'
    : value === 1n
      ? 'DelegateCall (1)'
      : `Invalid (${value.toString()})`;
}

function expiry(value: bigint): string {
  const milliseconds = value * 1000n;
  return milliseconds > 8640000000000000n
    ? `${value.toString()} (outside the supported date range)`
    : `${new Date(Number(milliseconds)).toISOString()} (${value.toString()} seconds)`;
}

function argumentValue(
  value: string | bigint,
  type: string,
  name: string,
  method: string | undefined,
  format: VaultFormat,
): string {
  if (typeof value === 'bigint') {
    if (name === 'operation') return operation(value);
    if (name === 'validUntil') return expiry(value);
    if (name === 'amount' || (name === 'value' && ['transfer', 'approve'].includes(method ?? '')))
      return `${value.toString()} base units`;
    return value.toString();
  }
  if (type === 'address') return groupQrlAddress(value);
  if (name === 'role') {
    const role = vaultRoleLabel(value);
    if (role) return `${role} (${value})`;
  }
  return type === 'bytes' ? format.bytes(value) : value;
}

function* argumentRows(
  value: VaultAbiValue,
  type: string,
  name: string,
  method: string | undefined,
  format: VaultFormat,
): Generator<VaultReviewRow> {
  if (typeof value === 'string' || typeof value === 'bigint') {
    yield valueRow(
      'argument',
      `${name} (${type}): ${argumentValue(value, type, name, method, format)}`,
    );
  } else if (value.length === 0) {
    yield valueRow('argument', `${name} (${type}): []`);
  } else {
    for (const [index, item] of value.entries()) {
      yield* argumentRows(item, type.replace(/\[\]$/, ''), `${name}[${index}]`, method, format);
    }
  }
}

function callRows(call: DecodedVaultCall, format: VaultFormat): VaultReviewRow[] {
  const token = call.method === 'transfer' || call.method === 'approve';
  const method = token ? `QRC-20 ${call.method}` : call.method;
  const rows = [
    valueRow(token ? 'destination/token' : 'destination', groupQrlAddress(call.to)),
    valueRow('value', format.quanta(call.value)),
    valueRow('operation', operation(call.operation)),
    ...call.warnings.map((code) => warning(WARNINGS[code])),
    valueRow('calldata', `${method ?? call.status} (${call.data.slice(0, 10)})`),
  ];
  if (call.status !== 'decoded') rows.push(valueRow('bytes', format.bytes(call.data)));
  for (const arg of call.args) {
    // The decoder has validated each full batch. Its parallel arrays and packed
    // transactions are represented together in the indivisible entry groups.
    if (
      call.children.length > 0 &&
      ((call.method === 'multiSend' && arg.name === 'transactions') ||
        (['scheduleBatch', 'executeBatch'].includes(call.method ?? '') &&
          ['targets', 'values', 'payloads'].includes(arg.name)))
    )
      continue;
    rows.push(...argumentRows(arg.value, arg.type, arg.name, call.method, format));
  }
  if (call.children.length > 0) {
    rows.push(
      valueRow('enclosed calls', `${call.children.length} entries, shown individually below`),
    );
  }
  return rows;
}

export function vaultReview(
  payload: TypedDataPayload,
  format: VaultFormat,
  now = Date.now(),
): VaultReview | undefined {
  const request = recognizeVaultRequest(payload);
  if (!request) {
    if (payload.domain['name'] !== 'QuantaVault') return undefined;
    const groups = [
      [
        warning(
          'WARNING: QuantaVault-named domain has an unrecognized schema. Review the raw fields.',
        ),
      ],
    ];
    return { groups, collapsed: groups };
  }
  const rows = [
    warning(ASSUMPTION),
    valueRow(
      'approval',
      request.kind === 'VaultTx'
        ? 'Execute a vault transaction'
        : request.kind === 'VaultApproval'
          ? 'Approve an outer vault transaction through the approving vault'
          : 'Sign a vault message',
    ),
    valueRow(
      request.kind === 'VaultApproval' ? 'approving vault' : 'address',
      groupQrlAddress(request.vault),
    ),
  ];
  let entries = 1;
  let delegateCalls = 0;
  const children: VaultReviewRow[][] = [];
  if (request.kind === 'VaultMessage') {
    if (request.message.length === 130) rows.push(warning(WARNINGS.opaqueApproval));
    rows.push(valueRow('message', format.bytes(request.message)));
  } else {
    if (hasVaultRefund(request.tx)) {
      throw new Error('QuantaVault refunds are unsupported. All refund fields must be zero.');
    }
    if (request.kind === 'VaultApproval')
      rows.push(valueRow('outer vault', groupQrlAddress(request.outerVault)));
    const call = decodeVaultCall(request.tx, request.chainId);
    rows.push(...callRows(call, format));
    const batch = ['multiSend', 'scheduleBatch', 'executeBatch'].includes(call.method ?? '');
    const calls = batch || call.children.length ? call.children : [call];
    entries = calls.length;
    delegateCalls = calls.filter((entry) => entry.operation === 1n).length;
    for (const [index, child] of call.children.entries()) {
      children.push([valueRow('entry', `${index + 1} of ${entries}`), ...callRows(child, format)]);
    }
    // These belong to the signed VaultTx, so keep them before the batch groups.
    rows.push(valueRow('nonce', request.tx.nonce.toString()));
    rows.push(valueRow('validUntil', expiry(request.tx.validUntil)));
    if (request.tx.validUntil === VAULT_MAX_UINT256)
      rows.push(warning('WARNING: Maximum validUntil grants effectively unlimited validity.'));
    else if (request.tx.validUntil > BigInt(Math.floor(now / 1000)) + 30n * 86400n)
      rows.push(warning('WARNING: validUntil is more than 30 days away.'));
  }
  const groups = [...rows.map((row) => [row]), ...children];
  const warnings = new Set(groups.flat().flatMap((row) => ('warning' in row ? [row.warning] : [])));
  return {
    groups,
    collapsed: [
      [
        valueRow(
          'summary',
          `${entries} entries, decoding omitted, ${delegateCalls} DelegateCall entries`,
        ),
      ],
      ...[...warnings].map((text) => [warning(text)]),
    ],
  };
}
