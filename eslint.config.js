// @ts-check
/**
 * ESLint 9 flat config (ESM, because package.json sets "type": "module").
 *
 * Built from the installed @typescript-eslint plugin's own flat presets plus
 * @eslint/js recommended, so it runs against exactly the declared devDeps
 * (no umbrella "typescript-eslint" package required).
 *
 * The load-bearing block here is the crypto-boundary guard: node:crypto,
 * @node-rs/argon2, and the @theqrl signing libraries may only be imported
 * inside src/signer/**. Everywhere else those imports are an error, so a stray
 * edit cannot start materialising key material outside the signer
 * utilityProcess. The signer (and the crypto tests) override that ban.
 */
import eslintJs from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import globals from 'globals';

/** Modules that must never be imported outside the signer process. */
const CRYPTO_ONLY_MODULES = [
  'node:crypto',
  'crypto',
  '@node-rs/argon2',
  '@theqrl/mldsa87',
  '@theqrl/wallet.js',
  '@theqrl/web3',
];

const cryptoImportGuard = {
  paths: CRYPTO_ONLY_MODULES.map((name) => ({
    name,
    message:
      'Cryptographic primitives may only be imported inside src/signer/**. Route key material through the signer utilityProcess.',
  })),
};

export default [
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

  // Default rules + Node globals for the TypeScript sources (main, preload,
  // signer, shared). Browser globals are layered on per folder below.
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // No type laundering (owner mandate). The compiler's view of a value is
      // never widened or rewritten by hand: wire input is `unknown` and gets
      // runtime guards. `as const` stays legal under assertionStyle 'never'.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-ignore': true,
          'ts-nocheck': true,
          'ts-expect-error': 'allow-with-description',
          minimumDescriptionLength: 10,
        },
      ],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // Narrowed wire records are read with bracket access (isRecord guards).
      '@typescript-eslint/dot-notation': ['error', { allowIndexSignaturePropertyAccess: true }],
      '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],
      // The crypto fence. The signer + test overrides below switch it off.
      'no-restricted-imports': ['error', cryptoImportGuard],
      // The renderer must reach the wallet only via window.qrlWallet. Direct
      // ipcRenderer use anywhere (a classic Electron footgun) is banned; the
      // preload is the sole, narrow bridge. Do NOT expose ipcRenderer raw.
      'no-restricted-globals': [
        'error',
        {
          name: 'ipcRenderer',
          message:
            'Never touch ipcRenderer directly. The preload contextBridge exposes the only allowed surface (window.qrlWallet).',
        },
      ],
      // Keep inline eslint-disable comments working for the two intentional
      // suppressions the core ships (a require in security.ts and a single
      // no-explicit-any in signing.ts).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
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
      'no-restricted-imports': 'off',
    },
  },

  // Browser-context surfaces: the native unlock + settings windows. Browser
  // globals, no Node globals. The crypto fence and the ipcRenderer-global ban
  // stay in force here (inherited from the base block).
  {
    files: ['src/unlock/**/*.{ts,tsx}', 'src/settings/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
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
      'no-restricted-imports': 'off',
      // Tests exercise malformed input and mock internals, so assertions and
      // loose typing are legitimate there. The production rules above stay at
      // error for every file outside test/.
      '@typescript-eslint/consistent-type-assertions': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
    },
  },
];
