import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ESLint } from 'eslint';

const eslint = new ESLint();
type ImportKind = 'static' | 'dynamic' | 'template';

async function forbidden(filePath: string, module: string, kind: ImportKind): Promise<boolean> {
  const source =
    kind === 'static'
      ? `import * as primitive from '${module}';\nexport { primitive };\n`
      : `export const primitive = await import(${kind === 'template' ? '`' : "'"}${module}${kind === 'template' ? '`' : "'"});\n`;
  const results = await eslint.lintText(source, { filePath });
  assert.equal(results.length, 1);
  assert.ok(results.every((result) => result.fatalErrorCount === 0));
  return results.some((result) =>
    result.messages.some(
      (message) =>
        message.ruleId === (kind === 'static' ? 'no-restricted-imports' : 'no-restricted-syntax'),
    ),
  );
}

const modules = [
  'node:crypto',
  'crypto',
  '@noble/hashes',
  '@node-rs/argon2',
  '@theqrl/mldsa87',
  '@theqrl/wallet.js',
  '@theqrl/web3',
  '@theqrl/qrl-cryptography',
];

for (const kind of ['static', 'dynamic', 'template'] as const) {
  test(`${kind} crypto imports fence package roots and subpaths in every restricted scope`, async () => {
    for (const file of [
      'src/main/confirm.ts',
      'src/preload/index.ts',
      'src/shared/address.ts',
      'src/ledger/qrlLedger.ts',
      'src/unlock/main.tsx',
      'src/settings/main.tsx',
    ]) {
      for (const module of [
        ...modules,
        ...modules.map((name) => `${name}/internal`),
        '@noble/hashes/sha3.js',
      ]) {
        assert.equal(await forbidden(file, module, kind), true, `${file}: ${module}`);
      }
    }
  });

  test(`${kind} imports preserve only the exact public SHAKE256 exception in the checksum helper`, async () => {
    assert.equal(
      await forbidden('src/shared/addressCase.ts', '@noble/hashes/sha3.js', kind),
      false,
    );
    for (const module of [...modules, '@noble/hashes/sha2.js', '@noble/hashes/sha3.js/internal']) {
      assert.equal(await forbidden('src/shared/addressCase.ts', module, kind), true, module);
    }
  });

  test(`${kind} crypto imports remain available to signer, calibration and tests`, async () => {
    for (const file of [
      'src/signer/signing.ts',
      'scripts/calibrate-kdf.ts',
      'test/cryptoImportFence.test.ts',
    ]) {
      for (const module of modules) {
        assert.equal(await forbidden(file, module, kind), false, `${file}: ${module}`);
      }
    }
  });

  test(`${kind} imports allow unrelated modules and similar package names`, async () => {
    for (const module of [
      'node:path',
      'crypto-extra',
      '@noble/hashes-extra',
      '@theqrl/walletXjs',
    ]) {
      assert.equal(await forbidden('src/main/confirm.ts', module, kind), false, module);
    }
  });
}
