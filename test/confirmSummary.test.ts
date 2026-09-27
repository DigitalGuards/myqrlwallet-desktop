/**
 * Trusted confirm-window text (src/main/confirmSummary.ts).
 *
 * The dialog is the ONLY place the user authorises a spend, so what it states
 * has to be derived from the transaction that will actually be signed, and it
 * has to be honest about which of those numbers the wallet chose. Verified
 * here:
 *   - the gas limit shown is the limit in the transaction, including a
 *     dApp-requested limit the builder honoured over its own estimate
 *   - the row names the source: the wallet's own estimate, or the dApp with
 *     the wallet's estimate alongside it
 *   - a limit far above the estimate raises a warning, while ordinary
 *     settlement headroom (estimateGas + 250000) stays silent
 *   - with no build record the dialog says the fee fields were not assembled
 *     by this wallet
 *   - max fee and max cost are computed from the gas limit in the transaction,
 *     and the max cost is repeated in the prominent message line
 *   - the amount, addresses, nonce and chain id still come straight from the
 *     transaction, and dApp provenance stays labelled unverified
 *
 * Electron-free by construction (the dialog call itself lives in confirm.ts),
 * so this runs under `node --test --import tsx`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatQuanta,
  gasWarningThreshold,
  summariseSignatureRequest,
} from '../src/main/confirmSummary';
import type { GasBuildRecord } from '../src/main/buildRecords';
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

const walletBuild = (estimatedGas: string): GasBuildRecord => ({ estimatedGas });
const dappBuild = (estimatedGas: string, requestedGas: string): GasBuildRecord => ({
  estimatedGas,
  requestedGas,
});

test('formatQuanta trims to the shortest exact Quanta spelling', () => {
  assert.equal(formatQuanta('0'), '0 Quanta');
  assert.equal(formatQuanta('1000000000000000000'), '1 Quanta');
  assert.equal(formatQuanta('1500000000000000000'), '1.5 Quanta');
  assert.equal(formatQuanta(240_000n * GWEI), '0.00024 Quanta');
});

test('the confirm window shows the gas limit that is in the transaction', () => {
  const { detail } = summariseSignatureRequest(
    txRequest({ gas: '350000' }),
    dappBuild('120000', '350000'),
  );
  assert.match(detailRow(detail, 'Gas limit:'), /^350000\b/);
});

test('the gas row names the dApp as the source and shows the wallet estimate', () => {
  const { detail } = summariseSignatureRequest(
    txRequest({ gas: '350000' }),
    dappBuild('120000', '350000'),
  );
  assert.equal(detailRow(detail, 'Gas limit:'), '350000 (set by the dApp; wallet estimate 120000)');
});

test('the gas row names the wallet when no dApp limit was involved', () => {
  const { detail } = summariseSignatureRequest(txRequest({ gas: '120000' }), walletBuild('120000'));
  assert.equal(detailRow(detail, 'Gas limit:'), "120000 (this wallet's estimate)");
  assert.doesNotMatch(detail, /set by the dApp/);
});

test('with no build record the dialog says the wallet did not assemble the fees', () => {
  const { detail } = summariseSignatureRequest(txRequest({ gas: '350000' }));
  assert.equal(detailRow(detail, 'Gas limit:'), '350000');
  assert.match(detail, /the fee fields were not assembled by this wallet/);
  assert.doesNotMatch(detail, /set by the dApp/);
});

test('ordinary settlement headroom does not raise a warning', () => {
  // QuantaSwap HTLCv3 asks for estimateGas + 250000 at every realistic size.
  for (const [estimate, requested] of [
    ['120000', '350000'],
    ['21000', '271000'],
    ['800000', '1050000'],
  ] as const) {
    const { detail } = summariseSignatureRequest(
      txRequest({ gas: requested }),
      dappBuild(estimate, requested),
    );
    assert.doesNotMatch(detail, /WARNING/, `estimate ${estimate} + 250000 must stay silent`);
  }
});

test('a gas limit far above the estimate raises a warning', () => {
  // 120000 estimate: the allowance is max(480000, 1120000) = 1120000.
  const quiet = summariseSignatureRequest(
    txRequest({ gas: '1120000' }),
    dappBuild('120000', '1120000'),
  ).detail;
  assert.doesNotMatch(quiet, /WARNING/, 'the threshold itself is not a warning');

  const loud = summariseSignatureRequest(
    txRequest({ gas: '1120001' }),
    dappBuild('120000', '1120001'),
  ).detail;
  assert.match(loud, /WARNING: the dApp asked for far more gas/);
  // The warning stays truthful about what the excess costs.
  assert.match(loud, /unused part is refunded/);

  // On a large estimate the multiplicative term is the binding one.
  const large = summariseSignatureRequest(
    txRequest({ gas: '20000001' }),
    dappBuild('5000000', '20000001'),
  ).detail;
  assert.match(large, /WARNING/);
});

test('gasWarningThreshold takes the higher of 4x and +1,000,000', () => {
  assert.equal(gasWarningThreshold(120_000n), 1_120_000n, 'flat term binds on a small estimate');
  assert.equal(gasWarningThreshold(5_000_000n), 20_000_000n, 'the 4x term binds on a large one');
  assert.equal(gasWarningThreshold(333_334n), 1_333_336n, 'the terms cross just above 333,333');
});

test('max fee and max cost follow the honoured gas limit', () => {
  // 120000 gas at a 2 gwei cap = 0.00024 Quanta, on top of a 1 Quanta send.
  const estimated = summariseSignatureRequest(
    txRequest({ gas: '120000' }),
    walletBuild('120000'),
  ).detail;
  assert.equal(detailRow(estimated, 'Max fee:').split(' (')[0], '0.00024 Quanta');
  assert.equal(detailRow(estimated, 'Max cost:'), '1.00024 Quanta');

  // A dApp-requested 350000 raises the worst case the user is asked to accept.
  const honoured = summariseSignatureRequest(
    txRequest({ gas: '350000' }),
    dappBuild('120000', '350000'),
  ).detail;
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

test('the prominent message line carries the max cost', () => {
  const { message } = summariseSignatureRequest(
    txRequest({ gas: '350000', value: '0' }),
    dappBuild('120000', '350000'),
  );
  // A zero-value contract call: the fee IS the whole cost, so a message that
  // only said "Send 0 Quanta?" would read as free.
  assert.equal(message, 'Send 0 Quanta? Max cost 0.0007 Quanta.');
});

test('max cost of a zero-value contract call is the fee alone', () => {
  const { detail } = summariseSignatureRequest(txRequest({ gas: '350000', value: '0' }));
  assert.equal(detailRow(detail, 'Amount:'), '0 Quanta');
  assert.equal(detailRow(detail, 'Max cost:'), '0.0007 Quanta');
});

test('the transaction facts come from the transaction', () => {
  const { title, detail } = summariseSignatureRequest(txRequest(), walletBuild('120000'));
  assert.equal(title, 'Confirm transaction');
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
  const { detail } = summariseSignatureRequest(withOrigin, dappBuild('120000', '350000'));
  assert.match(detail, /Requested by dApp \(unverified, dApp-supplied\):/);
  assert.match(detail, /Name: {4}QuantaSwap/);
  assert.match(detailRow(detail, 'Gas limit:'), /^350000\b/, 'the fee block is unaffected');
});
