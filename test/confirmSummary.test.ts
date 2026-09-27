/**
 * Trusted confirm-window text (src/main/confirmSummary.ts).
 *
 * The dialog is the ONLY place the user authorises a spend, so what it states
 * has to be derived from the transaction that will actually be signed. Verified
 * here:
 *   - the gas limit shown is the limit in the transaction, including a
 *     dApp-requested limit the builder honoured over its own estimate
 *   - max fee and max cost are computed from THAT gas limit, so a larger limit
 *     raises the worst case the user sees
 *   - the amount, addresses, nonce and chain id still come straight from the
 *     transaction, and dApp provenance stays labelled unverified
 *
 * Electron-free by construction (the dialog call itself lives in confirm.ts),
 * so this runs under `node --test --import tsx`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatQuanta, summariseSignatureRequest } from '../src/main/confirmSummary';
import type { SignatureRequest } from '../src/shared/schemas';

const ADDR = 'Q' + 'a'.repeat(128);
const ADDR2 = 'Q' + 'b'.repeat(128);

const GWEI = 1_000_000_000n;

function txRequest(overrides: { gas?: string; value?: string } = {}): SignatureRequest {
  return {
    kind: 'transaction',
    tx: {
      from: ADDR,
      to: ADDR2,
      value: overrides.value ?? '1000000000000000000', // 1 Quanta
      nonce: 5,
      gas: overrides.gas ?? '120000',
      maxFeePerGas: (2n * GWEI).toString(10),
      maxPriorityFeePerGas: GWEI.toString(10),
      chainId: 3151909,
      type: '0x2',
    },
  };
}

/** Pull the value of one aligned `Label:   value` detail row. */
function detailRow(detail: string, label: string): string {
  const line = detail.split('\n').find((l) => l.startsWith(label));
  assert.ok(line, `expected a "${label}" row in:\n${detail}`);
  return line.slice(label.length).trim();
}

test('formatQuanta trims to the shortest exact Quanta spelling', () => {
  assert.equal(formatQuanta('0'), '0 Quanta');
  assert.equal(formatQuanta('1000000000000000000'), '1 Quanta');
  assert.equal(formatQuanta('1500000000000000000'), '1.5 Quanta');
  assert.equal(formatQuanta(240_000n * GWEI), '0.00024 Quanta');
});

test('the confirm window shows the gas limit that is in the transaction', () => {
  const { detail } = summariseSignatureRequest(txRequest({ gas: '350000' }));
  assert.equal(detailRow(detail, 'Gas limit:'), '350000');
});

test('max fee and max cost follow the honoured gas limit, not an estimate', () => {
  // 120000 gas at a 2 gwei cap = 0.00024 Quanta, on top of a 1 Quanta send.
  const estimated = summariseSignatureRequest(txRequest({ gas: '120000' })).detail;
  assert.equal(detailRow(estimated, 'Max fee:').split(' (')[0], '0.00024 Quanta');
  assert.equal(detailRow(estimated, 'Max cost:'), '1.00024 Quanta');

  // A dApp-requested 350000 raises the worst case the user is asked to accept.
  const honoured = summariseSignatureRequest(txRequest({ gas: '350000' })).detail;
  assert.equal(detailRow(honoured, 'Max fee:').split(' (')[0], '0.0007 Quanta');
  assert.equal(detailRow(honoured, 'Max cost:'), '1.0007 Quanta');
});

test('the max-fee row names the per-gas caps it was computed from', () => {
  const { detail } = summariseSignatureRequest(txRequest({ gas: '350000' }));
  assert.equal(
    detailRow(detail, 'Max fee:'),
    '0.0007 Quanta (up to 2000000000 per gas, priority 1000000000)',
  );
});

test('max cost of a zero-value contract call is the fee alone', () => {
  const { detail } = summariseSignatureRequest(txRequest({ gas: '350000', value: '0' }));
  assert.equal(detailRow(detail, 'Amount:'), '0 Quanta');
  assert.equal(detailRow(detail, 'Max cost:'), '0.0007 Quanta');
});

test('the transaction facts and the send prompt come from the transaction', () => {
  const { title, message, detail } = summariseSignatureRequest(txRequest());
  assert.equal(title, 'Confirm transaction');
  assert.equal(message, 'Send 1 Quanta?');
  assert.equal(detailRow(detail, 'Nonce:'), '5');
  assert.equal(detailRow(detail, 'Chain id:'), '3151909');
  assert.equal(detailRow(detail, 'Data:'), '(none)');
});

test('dApp provenance stays present and labelled unverified alongside the fee block', () => {
  const req = txRequest({ gas: '350000' });
  assert.equal(req.kind, 'transaction');
  const withOrigin: SignatureRequest = {
    ...req,
    origin: {
      via: 'dapp',
      name: 'QuantaSwap',
      url: 'https://quantaswap.io',
      channelId: 'abcdef01',
    },
  };
  const { detail } = summariseSignatureRequest(withOrigin);
  assert.match(detail, /Requested by dApp \(unverified, dApp-supplied\):/);
  assert.match(detail, /Name: {4}QuantaSwap/);
  assert.equal(detailRow(detail, 'Gas limit:'), '350000', 'the fee block is unaffected');
});
