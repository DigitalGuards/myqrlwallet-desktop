/**
 * The renderer's explorer (token and NFT discovery) must be reachable under
 * the main-process CSP. The renderer build default and connect-src are
 * configured in two files, so pin them together: a mismatch makes discovery
 * fail silently with a blocked fetch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(here, '../src/main/config.ts');
const rendererScript = path.join(here, '../scripts/build-renderer.sh');

function connectSrc(): string[] {
  const script = `import('${configPath.replace(/\\/g, '/')}').then((c) => { process.stdout.write(JSON.stringify(c.connectSrcOrigins())); });`;
  const out = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module'], {
    input: script,
    env: { ...process.env, QRL_FRONTEND_ORIGINS: undefined },
    encoding: 'utf8',
  });
  return JSON.parse(out) as string[];
}

function rendererDefault(name: string): string {
  const match = new RegExp(`${name}="\\$\\{${name}:-([^}]+)\\}"`).exec(
    readFileSync(rendererScript, 'utf8'),
  );
  assert.ok(match, `${name} default not found in build-renderer.sh`);
  return match[1] ?? '';
}

test('the renderer explorer defaults are allowed by connect-src', () => {
  const allowed = connectSrc();
  for (const name of ['VITE_EXPLORER_URL_PRODUCTION', 'VITE_EXPLORER_URL_DEVELOPMENT']) {
    const origin = new URL(rendererDefault(name)).origin;
    assert.ok(allowed.includes(origin), `${origin} (${name}) is missing from connect-src`);
  }
});

test('the explorer is zondscan.com', () => {
  assert.equal(rendererDefault('VITE_EXPLORER_URL_PRODUCTION'), 'https://zondscan.com');
  assert.ok(connectSrc().includes('https://zondscan.com'));
});
