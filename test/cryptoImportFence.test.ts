import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ESLint } from 'eslint';

const eslint = new ESLint();
async function forbidden(filePath: string, module: string): Promise<boolean> {
  const results = await eslint.lintText(
    `import * as primitive from '${module}';\nexport { primitive };\n`,
    { filePath },
  );
  assert.equal(results.length, 1);
  assert.ok(results.every((result) => result.fatalErrorCount === 0));
  return results.some((result) =>
    result.messages.some((message) => message.ruleId === 'no-restricted-imports'),
  );
}

test('hash package roots and subpaths stay fenced from main, preload, Ledger and ordinary shared code', async () => {
  for (const file of [
    'src/main/confirm.ts',
    'src/preload/index.ts',
    'src/shared/address.ts',
    'src/ledger/qrlLedger.ts',
  ]) {
    for (const module of [
      '@noble/hashes',
      '@noble/hashes/sha3.js',
      '@noble/hashes/sha2.js',
      '@theqrl/qrl-cryptography',
    ]) {
      assert.equal(await forbidden(file, module), true, `${file}: ${module}`);
    }
  }
});

test('the address checksum helper has only its explicit public SHAKE256 exception', async () => {
  assert.equal(await forbidden('src/shared/addressCase.ts', '@noble/hashes/sha3.js'), false);
  for (const module of [
    '@noble/hashes',
    '@noble/hashes/sha2.js',
    'node:crypto',
    '@theqrl/wallet.js',
    '@theqrl/qrl-cryptography',
  ]) {
    assert.equal(await forbidden('src/shared/addressCase.ts', module), true, module);
  }
});
