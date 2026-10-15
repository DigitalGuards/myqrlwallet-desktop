// @ts-check
/**
 * ESLint flat config (ESM, because package.json sets "type": "module").
 *
 * Built from the installed @typescript-eslint plugin's own flat presets plus
 * @eslint/js recommended, so it runs against exactly the declared devDeps
 * (no umbrella "typescript-eslint" package required).
 *
 * The load-bearing block here is the crypto-boundary guard: node:crypto,
 * @noble/hashes, @node-rs/argon2, and the @theqrl signing libraries are fenced
 * to src/signer/**, with one public address-checksum exception. A stray
 * edit cannot start materialising key material outside the signer
 * utilityProcess. The signer (and the crypto tests) override that ban.
 */
import eslintJs from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import nodeTest from './scripts/eslint-node-test.mjs';

export const strictFiles = ['**/*.{ts,tsx}'];
const rendererFiles = ['src/unlock/**/*.{ts,tsx}', 'src/settings/**/*.{ts,tsx}'];
const rendererPreloads = ['src/unlock/preload.ts', 'src/settings/preload.ts'];
const doubleAssertionGuard = {
  selector: 'TSAsExpression > TSAsExpression',
  message: 'Double type assertions are banned. Narrow unknown input with a guard.',
};

/** Modules that must never be imported outside the signer process. */
const CRYPTO_ONLY_MODULES = [
  'node:crypto',
  'crypto',
  '@noble/hashes',
  '@node-rs/argon2',
  '@theqrl/mldsa87',
  '@theqrl/wallet.js',
  '@theqrl/web3',
  '@theqrl/qrl-cryptography',
];

const CRYPTO_IMPORT_MESSAGE =
  'Cryptographic primitives may only be imported inside src/signer/**. Route key material through the signer utilityProcess.';

const cryptoImportGuard = {
  paths: CRYPTO_ONLY_MODULES.map((name) => ({
    name,
    message: CRYPTO_IMPORT_MESSAGE,
  })),
  patterns: [
    { group: CRYPTO_ONLY_MODULES.map((name) => `${name}/*`), message: CRYPTO_IMPORT_MESSAGE },
  ],
};

const IPC_RENDERER_MESSAGE =
  'Never touch ipcRenderer directly. The preload contextBridge exposes the only allowed surface (window.qrlWallet).';
const ipcRendererImportGuard = {
  name: 'electron',
  importNames: ['ipcRenderer'],
  message: IPC_RENDERER_MESSAGE,
};
const importGuard = {
  ...cryptoImportGuard,
  paths: [...cryptoImportGuard.paths, ipcRendererImportGuard],
};

const cryptoModulePattern = CRYPTO_ONLY_MODULES.map((name) =>
  name.replaceAll('.', '\\.').replaceAll('/', '\\u002F'),
).join('|');

function cryptoDynamicImportGuard(allowChecksum = false) {
  return [
    ['ImportExpression', 'source.value'],
    [
      'ImportExpression > TemplateLiteral.source[expressions.length=0] > TemplateElement',
      'value.cooked',
    ],
  ].map(([node, property]) => ({
    selector:
      `${node}[${property}=/^(${cryptoModulePattern})($|\\u002F)/]` +
      (allowChecksum ? `[${property}!='@noble/hashes/sha3.js']` : ''),
    message: CRYPTO_IMPORT_MESSAGE,
  }));
}

export const baseConfig = [
  {
    // Build output, vendored reference, deps, and type-only files: never linted.
    ignores: [
      'out/**',
      'release/**',
      'dist/**',
      'node_modules/**',
      'railway-wallet-reference/**',
      '**/*.d.ts',
    ],
  },

  { linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'error' } },
  eslintJs.configs.recommended,
  // The plugin's flat/recommended array registers the @typescript-eslint plugin
  // and its TypeScript parser/languageOptions for us.
  ...tsPlugin.configs['flat/strict-type-checked'],
  ...tsPlugin.configs['flat/stylistic-type-checked'],

  // Plain JS / CJS files sit outside the TypeScript project: no type-aware rules.
  {
    files: ['**/*.{js,cjs,mjs}'],
    ...tsPlugin.configs['flat/disable-type-checked'],
  },

  // App code and tests share the strict rules and hardened type boundaries.
  {
    files: strictFiles,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'node-test': nodeTest,
    },
    rules: {
      // No type laundering (owner mandate). The compiler's view of a value is
      // never widened or rewritten by hand: wire input is `unknown` and gets
      // runtime guards. `as const` stays legal under assertionStyle 'never'.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'separate-type-imports',
          disallowTypeAnnotations: false,
        },
      ],
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-ignore': true,
          'ts-nocheck': true,
          'ts-expect-error': true,
        },
      ],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // Narrowed wire records are read with bracket access (isRecord guards).
      '@typescript-eslint/dot-notation': ['error', { allowIndexSignaturePropertyAccess: true }],
      // Retain the base options while this PR changes tooling only. Tightening
      // arrow shorthand requires source fixes before these exceptions can go.
      '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],
      'node-test/no-floating-subtests': 'error',
      // The crypto fence. The signer + test overrides below switch it off.
      'no-restricted-imports': ['error', importGuard],
      'no-restricted-syntax': ['error', doubleAssertionGuard, ...cryptoDynamicImportGuard()],
      // The renderer must reach the wallet only via window.qrlWallet. Direct
      // ipcRenderer use anywhere (a classic Electron footgun) is banned; the
      // preload is the sole, narrow bridge. Do NOT expose ipcRenderer raw.
      'no-restricted-globals': [
        'error',
        {
          name: 'ipcRenderer',
          message: IPC_RENDERER_MESSAGE,
        },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        // Keep the base options for unused bindings, including caught errors.
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      'no-console': 'error',
    },
  },

  {
    // Preserve the existing bounded no-control-regex suppression. The rule
    // remains enabled throughout the rest of this file, as on the base branch.
    files: ['src/shared/schemas.ts'],
    linterOptions: { noInlineConfig: false },
  },

  // Public address derivation and QIP-55 checks use SHAKE256. Every
  // other crypto module remains fenced, including other hash entry points.
  {
    files: ['src/shared/addressCase.ts'],
    rules: {
      'no-restricted-syntax': ['error', doubleAssertionGuard, ...cryptoDynamicImportGuard(true)],
      'no-restricted-imports': [
        'error',
        {
          ...importGuard,
          patterns: [
            {
              group: [
                ...CRYPTO_ONLY_MODULES.map((name) => `${name}/*`),
                '!@noble/hashes/sha3.js',
                '@noble/hashes/sha3.js/*',
              ],
              message: CRYPTO_IMPORT_MESSAGE,
            },
          ],
        },
      ],
    },
  },

  // Signer process: the ONLY place the crypto modules may be imported.
  // The KDF calibration dev script (scripts/calibrate-kdf.ts) also needs the
  // Argon2 binding directly; it never touches key material (it benchmarks
  // parameters), so it is allowed too.
  {
    files: ['src/signer/**/*.ts', 'scripts/calibrate-kdf.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: [ipcRendererImportGuard] }],
      'no-restricted-syntax': ['error', doubleAssertionGuard],
    },
  },

  {
    // Only the three preload entry points may import Electron's ipcRenderer.
    files: ['src/preload/index.ts', ...rendererPreloads],
    rules: { 'no-restricted-imports': ['error', cryptoImportGuard] },
  },

  // Main, signer, keyvault, shared code, tests and tooling run in Node.
  {
    files: strictFiles,
    ignores: rendererFiles,
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    // The unlock/settings preloads retain the narrow Node bridge context.
    files: rendererPreloads,
    languageOptions: {
      globals: globals.node,
    },
  },

  // Native unlock/settings renderers use browser globals and React rules.
  // The crypto fence and ipcRenderer guard remain inherited.
  {
    files: rendererFiles,
    ignores: rendererPreloads,
    languageOptions: {
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-hooks/exhaustive-deps': 'error',
      'react-refresh/only-export-components': 'error',
    },
  },
  {
    // Renderer entry points mount their local components into the DOM.
    files: ['src/unlock/main.tsx', 'src/settings/main.tsx'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
  {
    // The main logger is the single app console boundary. Calibration reports
    // KDF measurements to the terminal as development tooling.
    files: ['src/main/log.ts', 'scripts/calibrate-kdf.ts'],
    rules: {
      'no-console': 'off',
    },
  },

  // ES module scripts run in Node.js.
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: globals.node,
    },
  },

  // CommonJS build hooks (afterPack, notarize, pgp-sign): classic require/module.
  {
    files: ['scripts/**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  // Test files run under node:test / tsx and exercise the signer crypto
  // directly, so they are allowed the crypto imports too.
  {
    files: ['test/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-restricted-imports': ['error', { paths: [ipcRendererImportGuard] }],
      'no-restricted-syntax': ['error', doubleAssertionGuard],
      // The base disabled this rule in tests. Allow node:test registrations
      // here; application files retain the base rule's full enforcement.
      // The companion node-test rule checks floating TestContext.test calls.
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [
            { from: 'package', package: 'node:test', name: ['test', 'describe', 'it', 'suite'] },
          ],
        },
      ],
    },
  },
];

// Existing lint debt, including tests. Entries may only be removed.
// Regenerate with npm run lint:ratchet:update after fixing a file/rule pair.
// BEGIN LINT RATCHET
export const lintRatchet = [
  {
    files: ['src/main/ipc.ts'],
    rules: { '@typescript-eslint/consistent-type-imports': 'off', 'no-console': 'off' },
  },
  { files: ['src/main/rpc.ts'], rules: { 'no-console': 'off' } },
  { files: ['src/main/seedFile.ts'], rules: { 'no-console': 'off' } },
  { files: ['src/main/unlockWindow.ts'], rules: { 'no-console': 'off' } },
  {
    files: ['test/ledgerFixtures.ts'],
    rules: { '@typescript-eslint/consistent-type-assertions': 'off' },
  },
  {
    files: ['test/security.permissions.test.ts'],
    rules: {
      '@typescript-eslint/consistent-type-assertions': 'off',
      'no-restricted-syntax': 'off',
    },
  },
];
// END LINT RATCHET

export default [...baseConfig, ...lintRatchet];
