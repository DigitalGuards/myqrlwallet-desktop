/**
 * External-link allowlist. isAllowedExternalUrl gates which clicked links the
 * main process hands to the OS browser (shell.openExternal). The boundary cases
 * (lookalike hosts, embedded allowlist strings, non-https schemes) are exactly
 * where a bypass would hide, so they are the focus here. Pure function, runs
 * under `node --test` with no Electron.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isAllowedExternalUrl, EXTERNAL_ALLOWLIST } from '../src/main/externalLinks';

test('allows trusted ecosystem hosts over https (exact + subdomain)', () => {
  assert.equal(isAllowedExternalUrl('https://zondscan.com/tx/0xabc'), true);
  assert.equal(isAllowedExternalUrl('https://qrlwallet.com/'), true);
  assert.equal(isAllowedExternalUrl('https://dev.qrlwallet.com/'), true); // subdomain
  assert.equal(isAllowedExternalUrl('https://github.com/DigitalGuards/'), true);
  assert.equal(isAllowedExternalUrl('https://theqrl.org/'), true);
  assert.equal(isAllowedExternalUrl('https://t.me/someqrlchannel'), true);
});

test('rejects non-https schemes', () => {
  assert.equal(isAllowedExternalUrl('http://zondscan.com/'), false);
  assert.equal(isAllowedExternalUrl('file:///etc/passwd'), false);
  assert.equal(isAllowedExternalUrl('qrlconnect://pair'), false);
  assert.equal(isAllowedExternalUrl('data:text/html,hi'), false);
});

test('rejects lookalike and embedded-allowlist hosts', () => {
  assert.equal(isAllowedExternalUrl('https://evil-zondscan.com/'), false);
  assert.equal(isAllowedExternalUrl('https://zondscan.com.evil.test/'), false);
  assert.equal(isAllowedExternalUrl('https://notgithub.com/'), false);
  assert.equal(isAllowedExternalUrl('https://qrlwallet.com.attacker.io/'), false);
  assert.equal(isAllowedExternalUrl('https://evil.test/?ref=zondscan.com'), false);
});

test('rejects malformed and empty input', () => {
  assert.equal(isAllowedExternalUrl('not a url'), false);
  assert.equal(isAllowedExternalUrl(''), false);
});

test('allowlist is non-empty and lowercase', () => {
  assert.ok(EXTERNAL_ALLOWLIST.length > 0);
  for (const domain of EXTERNAL_ALLOWLIST) {
    assert.equal(domain, domain.toLowerCase(), `${domain} should be lowercase`);
  }
});
