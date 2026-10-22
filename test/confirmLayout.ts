import assert from 'node:assert/strict';
import { DETAIL_LINE_COLUMNS, displayWidth } from '../src/main/confirmSummary';

/** Remove one main-written direction mark per line and recover logical rows. */
export function unfoldDetail(detail: string): string {
  return detail.replace(/^\u200e/gmu, '').replace(/\n {4}(?:\| )?/gu, '');
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
  for (const markedLine of detail.split('\n')) {
    const hasDirection = markedLine.startsWith('\u200e');
    const line = hasDirection ? markedLine.slice(1) : markedLine;
    assert.equal(line.includes('\u200e'), false, 'only the main-written line prefix is raw');
    if (line === '') {
      assert.equal(hasDirection, false);
      source = undefined;
    } else if (line.startsWith('| ')) {
      assert.equal(hasDirection, true, `message gutter needs a leading LTR mark: ${line}`);
      source = undefined;
    } else if (line.startsWith('    | ')) {
      assert.equal(hasDirection, true, `continuation needs a leading LTR mark: ${line}`);
      assert.equal(source, 'dapp', `pipe on trusted text: ${line}`);
    } else if (trustedPrefixes.some((prefix) => line.startsWith(prefix))) {
      assert.equal(hasDirection, false);
      source = 'trusted';
    } else if (dappPrefixes.some((prefix) => line.startsWith(prefix))) {
      const absentValue =
        /^(?: {2})?URL: +\(not provided\)$|^Domain \w+: \(not provided\)$|^Data: +\(none\)$/u.test(
          line,
        );
      assert.ok(hasDirection || absentValue, `dApp label needs a leading LTR mark: ${line}`);
      source = hasDirection ? 'dapp' : 'trusted';
    } else if (line.startsWith('    ')) {
      assert.equal(hasDirection, false);
      assert.equal(source, 'trusted', `plain indent on dApp text: ${line}`);
      assert.equal(line.startsWith('     '), false, `trusted indent exceeds four spaces: ${line}`);
    } else {
      assert.fail(`missing main-written prefix: ${line}`);
    }
  }
}
