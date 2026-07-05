/**
 * RPC endpoint resolution (src/main/config.ts): the optional-secondary
 * semantics that let an operator DISABLE the public failover, so a private
 * primary never silently leaks a signed raw tx to the prod proxy.
 *
 * config.ts reads env at import time and each `await import` returns the cached
 * module, so each case runs in a fresh child process via a tiny inline script.
 * No Electron; pure Node.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(here, '../src/main/config.ts');

/** Import config.ts in a fresh tsx child with the given env and print JSON. */
function resolveConfig(env: Record<string, string | undefined>): {
  primary: string;
  secondary: string | null;
} {
  const script = `import('${configPath.replace(/\\/g, '/')}').then((c) => { process.stdout.write(JSON.stringify({ primary: c.RPC_URL, secondary: c.RPC_URL_SECONDARY ?? null })); });`;
  const out = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module'], {
    input: script,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return JSON.parse(out) as { primary: string; secondary: string | null };
}

test('unset secondary uses the prod proxy default', () => {
  const { secondary } = resolveConfig({ QRL_RPC_URL_SECONDARY: undefined });
  assert.equal(secondary, 'https://qrlwallet.com/api/qrl-rpc/testnet');
});

test('empty-string secondary DISABLES failover (no default leak)', () => {
  const { secondary } = resolveConfig({ QRL_RPC_URL_SECONDARY: '' });
  assert.equal(secondary, null);
});

test('"none" / "off" secondary disables failover', () => {
  assert.equal(resolveConfig({ QRL_RPC_URL_SECONDARY: 'none' }).secondary, null);
  assert.equal(resolveConfig({ QRL_RPC_URL_SECONDARY: 'off' }).secondary, null);
});

test('a malformed secondary disables failover rather than re-defaulting to prod', () => {
  const { secondary } = resolveConfig({ QRL_RPC_URL_SECONDARY: 'not a url' });
  assert.equal(secondary, null);
});

test('a valid secondary URL is honored (normalised, trailing slash trimmed)', () => {
  const { secondary } = resolveConfig({
    QRL_RPC_URL_SECONDARY: 'https://alt.example/rpc/',
  });
  assert.equal(secondary, 'https://alt.example/rpc');
});

test('a private primary can run with failover fully disabled', () => {
  const { primary, secondary } = resolveConfig({
    QRL_RPC_URL: 'http://127.0.0.1:8545',
    QRL_RPC_URL_SECONDARY: 'none',
  });
  assert.equal(primary, 'http://127.0.0.1:8545');
  assert.equal(secondary, null);
});
