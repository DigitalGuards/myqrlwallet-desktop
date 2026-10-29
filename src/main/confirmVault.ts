/** Payload-only QuantaVault review. Every value row is dApp-sourced by the caller. */
import { groupQrlAddress } from '../shared/address';
import { toChecksumQrlAddress } from '../shared/addressCase';
import { hasVaultRefund, recognizeVaultRequest, VAULT_MAX_UINT256 } from '../shared/quantaVault';
import {
  decodeVaultCall,
  VAULT_BATCH_METHODS,
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
  /** Built only after overflow; preserves top-level rows and every warning. */
  collapse?: () => VaultReviewRow[][];
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
  openRole: 'WARNING: Granting this role to the zero address opens it to everyone.',
  depthLimit:
    'WARNING: Deeper calls are unexpanded. This window shows only the first bytes. Verify the full calldata in the QuantaVault app before approving.',
  unknownCalldata:
    'WARNING: Unknown calldata. This window shows only the first bytes. Verify the full calldata in the QuantaVault app before approving.',
  invalidCalldata: 'WARNING: Invalid calldata. Decoding unavailable.',
  invalidOperation:
    'WARNING: The vault rejects every operation other than Call (0) and DelegateCall (1). This transaction cannot execute.',
  unlimitedAllowance:
    "WARNING: Unlimited QRC-20 allowance. If this is a QRC-20 token, the spender can spend the vault's entire token balance.",
};
const TX_GAS_WARNING =
  'WARNING: txGas is nonzero. A failed inner call can complete and spend the nonce. If txGas is below what the call needs, anyone executing can supply just enough gas to pass the gas check and force that failure.';

const displayAddress = (value: string): string => groupQrlAddress(toChecksumQrlAddress(value));

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
    if (name === 'amount')
      return `${value.toString()} base units${method === 'approve' || method === 'transferFrom' ? ' (QRC-20 amount or NFT token ID)' : ''}`;
    return value.toString();
  }
  if (type === 'address') return displayAddress(value);
  if (name === 'role') {
    const role = vaultRoleLabel(value);
    if (role) return `${role} (${value})`;
  }
  return type.startsWith('bytes') ? format.bytes(value) : value;
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
  const token = call.method === 'transfer';
  const method = token ? `QRC-20 ${call.method}` : call.method;
  const rows = [
    valueRow(token ? 'destination/token' : 'destination', displayAddress(call.to)),
    ...(call.batchTarget
      ? [
          warning(
            'NOTE: This batch entry named the zero address. Its effective target is the executing contract.',
          ),
        ]
      : []),
    valueRow('value', format.quanta(call.value)),
    valueRow('operation', operation(call.operation)),
    ...call.warnings.map((code) => warning(WARNINGS[code])),
    valueRow('calldata', `${method ?? call.status} (${call.data.slice(0, 10)})`),
  ];
  if (call.status !== 'decoded') rows.push(valueRow('bytes', format.bytes(call.data)));
  for (const arg of call.args) {
    // Expanded children already represent these arguments in complete entry groups.
    // At the depth boundary children are absent, so every argument stays visible.
    if (
      call.children.length > 0 &&
      (VAULT_BATCH_METHODS.has(call.method ?? '')
        ? ['transactions', 'targets', 'values', 'payloads'].includes(arg.name)
        : [
            'to',
            'target',
            'targetContract',
            'value',
            'data',
            'payload',
            'calldataPayload',
            'operation',
          ].includes(arg.name))
    )
      continue;
    rows.push(...argumentRows(arg.value, arg.type, arg.name, call.method, format));
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
    return { groups };
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
      displayAddress(request.vault),
    ),
  ];
  let childCalls: readonly DecodedVaultCall[] = [];
  const children: VaultReviewRow[][] = [];
  const gasRows: VaultReviewRow[] = [];
  if (request.kind === 'VaultMessage') {
    if (request.message.length === 130) rows.push(warning(WARNINGS.opaqueApproval));
    rows.push(valueRow('message', format.bytes(request.message)));
  } else {
    if (hasVaultRefund(request.tx)) {
      throw new Error('QuantaVault refunds are unsupported. All refund fields must be zero.');
    }
    if (request.kind === 'VaultApproval')
      rows.push(valueRow('outer vault', displayAddress(request.outerVault)));
    const call = decodeVaultCall(
      request.tx,
      request.chainId,
      request.kind === 'VaultApproval' ? request.outerVault : request.vault,
    );
    rows.push(...callRows(call, format));
    childCalls = call.children;
    for (const [index, child] of call.children.entries()) {
      children.push([
        valueRow('entry', `${index + 1} of ${call.children.length}`),
        ...callRows(child, format),
      ]);
    }
    // These belong to the signed VaultTx, so keep them before the batch groups.
    rows.push(valueRow('nonce', request.tx.nonce.toString()));
    rows.push(valueRow('validUntil', expiry(request.tx.validUntil)));
    const nowSeconds = BigInt(Math.floor(now / 1000));
    if (request.tx.validUntil < nowSeconds)
      rows.push(
        warning(
          "WARNING: According to this device's clock, this approval has already expired and the vault will reject it. The device clock may be incorrect.",
        ),
      );
    if (request.tx.validUntil === VAULT_MAX_UINT256)
      rows.push(warning('WARNING: Maximum validUntil grants effectively unlimited validity.'));
    else if (request.tx.validUntil > nowSeconds + 30n * 86400n)
      rows.push(warning('WARNING: validUntil is more than 30 days away.'));
    gasRows.push(valueRow('txGas', request.tx.txGas.toString()));
    if (request.tx.txGas !== 0n) gasRows.push(warning(TX_GAS_WARNING));
  }
  const topLevel = rows.map((row) => [row]);
  if (gasRows.length) topLevel.push(gasRows);
  const groups = [...topLevel, ...children];
  if (!children.length) return { groups };
  return {
    groups,
    collapse: () => {
      const delegateCalls = childCalls.filter((entry) => entry.operation === 1n).length;
      const seen = new Set(rows.flatMap((row) => ('warning' in row ? [row.warning] : [])));
      const warnings: VaultReviewRow[][] = [];
      for (const row of children.flat()) {
        if ('warning' in row && !seen.has(row.warning)) {
          seen.add(row.warning);
          warnings.push([row]);
        }
      }
      return [
        ...topLevel,
        [
          valueRow(
            'summary',
            `${children.length} entries, decoding omitted, ${delegateCalls} DelegateCall entries`,
          ),
        ],
        ...warnings,
      ];
    },
  };
}
