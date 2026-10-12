import assert from 'node:assert/strict';
import { DETAIL_LINE_COLUMNS, displayWidth } from '../src/main/confirmSummary';

/** Recover logical labelled rows while retaining every displayed character. */
export function unfoldDetail(detail: string): string {
  return detail.replace(/\n {4}(?:\| |(?=\S|$))/gu, '');
}

export function assertDetailWidth(detail: string): void {
  for (const line of detail.split('\n')) {
    assert.ok(displayWidth(line) <= DETAIL_LINE_COLUMNS, `overwide detail line: ${line}`);
  }
}

/** Continuations retain the trust of their fixed, main-written row prefix. */
export function assertTrustedLineStarts(detail: string): void {
  const dappPrefixes = [
    'message.',
    'To:',
    'Data:',
    'Name:',
    'URL:',
    '  Name:',
    '  URL:',
    '  Channel:',
    'Signing:',
    'Domain ',
    'Primary type:',
  ];
  const trustedPrefixes = [
    'Account:',
    'Amount:',
    'From:',
    'Nonce:',
    'Gas limit:',
    'Max fee:',
    'Max cost:',
    'Chain id:',
    'Requested by',
    'Scheme:',
    'Wallet network chainId:',
    'Message fields:',
    'Message (text, ',
    'Message (hex, ',
    'NOTE:',
    'WARNING:',
    'Approve only if you initiated this',
    'Only approve if you initiated this',
    'The encrypted seed will be deleted',
  ];
  let source: 'trusted' | 'dapp' | undefined;
  for (const line of detail.split('\n')) {
    if (line === '' || line.startsWith('| ')) {
      source = undefined;
    } else if (line.startsWith('    | ')) {
      assert.equal(source, 'dapp', `pipe on trusted text: ${line}`);
    } else if (trustedPrefixes.some((prefix) => line.startsWith(prefix))) {
      source = 'trusted';
    } else if (dappPrefixes.some((prefix) => line.startsWith(prefix))) {
      source = 'dapp';
    } else if (line.startsWith('    ')) {
      assert.equal(source, 'trusted', `plain indent on dApp text: ${line}`);
      assert.equal(line.startsWith('     '), false, `trusted indent exceeds four spaces: ${line}`);
    } else {
      assert.fail(`missing main-written prefix: ${line}`);
    }
  }
}
