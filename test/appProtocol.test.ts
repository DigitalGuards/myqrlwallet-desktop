import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { appAssetPath, createAppProtocolHandler } from '../src/main/appProtocol';
import { APP_URLS, isAppDocument } from '../src/shared/appUrls';

test('app asset paths reject ambiguous authorities, separators and traversal before URL normalization', () => {
  const roots = {
    wallet: '/bundle/wallet',
    unlock: '/bundle/unlock',
    settings: '/bundle/settings',
  };
  for (const url of [
    'file:///bundle/wallet/index.html',
    'app://other/index.html',
    'app://wallet.evil/index.html',
    'app://wallet:80/index.html',
    'app://user@wallet/index.html',
    'app://wallet/../unlock/index.html',
    'app://wallet/./index.html',
    'app://wallet/%2e%2E/index.html',
    'app://wallet/a/%2e/b',
    'app://wallet/%2fetc/passwd',
    'app://wallet/%5csecret',
    'app://wallet/a\\b',
    'app://wallet/%00secret',
    'app://wallet/a\0b',
    'app://wallet/%',
    'app://wallet/C:/file',
    'app://wallet/a.js:secret',
  ])
    assert.equal(appAssetPath(url, roots), null, url);
  assert.deepEqual(appAssetPath('app://wallet/tree.svg?cache=1', roots), {
    root: roots.wallet,
    file: '/bundle/wallet/tree.svg',
  });
  assert.equal(appAssetPath('app://unlock/assets/a.js', roots)?.root, roots.unlock);
  assert.equal(isAppDocument(APP_URLS.wallet + '#/address-book', APP_URLS.wallet), true);
  for (const url of [
    APP_URLS.unlock,
    'file:///wallet/index.html',
    'app://wallet/other.html',
    APP_URLS.wallet + '?x=1',
  ]) {
    assert.equal(isAppDocument(url, APP_URLS.wallet), false);
  }
});

test('handler contains real files and symlinks per surface and applies headers to every response', async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), 'app-protocol-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const roots = {
    wallet: path.join(base, 'wallet'),
    unlock: path.join(base, 'unlock'),
    settings: path.join(base, 'settings'),
  };
  for (const directory of Object.values(roots)) {
    await mkdir(path.join(directory, 'assets'), { recursive: true });
    await writeFile(path.join(directory, 'index.html'), path.basename(directory));
  }
  await writeFile(path.join(roots.wallet, 'tree.svg'), '<svg/>');
  await writeFile(path.join(base, 'secret'), 'outside');
  await symlink(path.join(base, 'secret'), path.join(roots.wallet, 'escape'));
  await symlink(roots.unlock, path.join(roots.wallet, 'other-surface'));
  await symlink(path.join(roots.wallet, 'tree.svg'), path.join(roots.wallet, 'inside.svg'));
  const handler = createAppProtocolHandler(
    roots,
    "default-src 'self'; worker-src 'self'",
    async (url) =>
      new Response(await readFile(new URL(url)), { headers: { 'Content-Type': 'text/plain' } }),
  );
  for (const [url, method, status, body] of [
    ['app://wallet/index.html', 'GET', 200, 'wallet'],
    ['app://unlock/index.html', 'GET', 200, 'unlock'],
    ['app://settings/index.html', 'GET', 200, 'settings'],
    ['app://wallet/tree.svg', 'GET', 200, '<svg/>'],
    ['app://wallet/inside.svg', 'GET', 200, '<svg/>'],
    ['app://wallet/index.html', 'HEAD', 200, ''],
    ['app://wallet/index.html', 'POST', 405, ''],
    ['app://wallet/escape', 'GET', 403, ''],
    ['app://wallet/other-surface/index.html', 'GET', 403, ''],
    ['app://wallet/missing', 'GET', 404, ''],
    ['app://wallet/assets', 'GET', 404, ''],
    ['app://wallet/../secret', 'GET', 403, ''],
  ] as const) {
    const response = await handler({ url, method });
    assert.equal(response.status, status, url);
    assert.equal(await response.text(), body, url);
    assert.equal(
      response.headers.get('Content-Security-Policy'),
      "default-src 'self'; worker-src 'self'",
    );
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(response.headers.get('X-DNS-Prefetch-Control'), 'off');
  }
});
