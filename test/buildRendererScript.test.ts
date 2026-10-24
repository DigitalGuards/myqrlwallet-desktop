import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

const SOURCE_SCRIPT = resolve('scripts/build-renderer.sh');

function policyDirectives(policy: string): Map<string, string[]> {
  return new Map(
    policy.split(';').map((directive) => {
      const [name, ...sources] = directive.trim().split(/\s+/);
      assert.ok(name);
      return [name, [...new Set(sources)].sort()];
    }),
  );
}

function runtimePolicy(env: NodeJS.ProcessEnv, connect: string[]): string {
  const security = new URL('../src/main/security.ts', import.meta.url).href;
  const loader = new URL('./electronMockLoader.mjs', import.meta.url).href;
  return execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module'], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    input: `import { register } from 'node:module';
register(${JSON.stringify(loader)});
const { buildContentSecurityPolicy } = await import(${JSON.stringify(security)});
process.stdout.write(buildContentSecurityPolicy(${JSON.stringify(connect)}));`,
  });
}

function makeFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'myqrlwallet-renderer-build-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const desktopDir = join(root, 'myqrlwallet-desktop');
  const scriptPath = join(desktopDir, 'scripts', 'build-renderer.sh');
  mkdirSync(dirname(scriptPath), { recursive: true });
  copyFileSync(SOURCE_SCRIPT, scriptPath);
  chmodSync(scriptPath, 0o755);

  return {
    root,
    desktopDir,
    frontendDir: join(root, 'myqrlwallet-frontend'),
    scriptPath,
  };
}

function writeMockNpm(binDir: string, includeCsp = true) {
  const npmPath = join(binDir, 'npm');
  const html = includeCsp
    ? `<!doctype html>
<html>
  <head>
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src *"
    />
  </head>
  <body><main>renderer</main></body>
</html>`
    : '<!doctype html><html><head></head><body><main>renderer</main></body></html>';
  writeFileSync(
    npmPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$NPM_CALL_LOG"
if [[ "$3" == "run" && "$4" == "build" ]]; then
  if [[ -n "\${NPM_ENV_LOG:-}" ]]; then
    printf '%s\\n' "$VITE_SERVER_URL_PRODUCTION" "$VITE_SERVER_URL_DEVELOPMENT" > "$NPM_ENV_LOG"
  fi
  mkdir -p "$2/dist"
  printf '%s\\n' '${html}' > "$2/dist/index.html"
fi
`,
    { mode: 0o755 },
  );
}

function runScript(scriptPath: string, binDir?: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const path = binDir ? `${binDir}:${process.env.PATH ?? ''}` : process.env.PATH;
  return spawnSync('bash', [scriptPath], {
    encoding: 'utf8',
    env: { ...process.env, QRL_FRONTEND_DIR: '', ...extraEnv, PATH: path },
  });
}

test('renderer build accepts an explicit source snapshot for isolated worktrees', (t) => {
  const fixture = makeFixture(t);
  const frontendDir = join(fixture.desktopDir, 'frontend-snapshot');
  const binDir = join(fixture.root, 'bin');
  const callLog = join(fixture.root, 'npm-calls.log');
  mkdirSync(frontendDir, { recursive: true });
  mkdirSync(binDir);
  writeFileSync(join(frontendDir, 'package-lock.json'), '{}\n');
  writeMockNpm(binDir);
  const result = runScript(fixture.scriptPath, binDir, {
    QRL_FRONTEND_DIR: frontendDir,
    NPM_CALL_LOG: callLog,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(callLog, 'utf8').trim().split('\n'), [
    `--prefix ${frontendDir} ci`,
    `--prefix ${frontendDir} run build`,
  ]);
  assert.match(
    readFileSync(join(fixture.desktopDir, 'out/renderer/index.html'), 'utf8'),
    /<main>renderer<\/main>/,
  );
});

test('renderer build fails when the frontend source is absent', (t) => {
  const fixture = makeFixture(t);
  const result = runScript(fixture.scriptPath);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /ERROR: frontend not found/);
});

test('renderer build requires a frontend lockfile', (t) => {
  const fixture = makeFixture(t);
  mkdirSync(fixture.frontendDir, { recursive: true });

  const result = runScript(fixture.scriptPath);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /ERROR: frontend lockfile not found/);
});

test('renderer build always installs from the lock and stages index.html', (t) => {
  const fixture = makeFixture(t);
  const binDir = join(fixture.root, 'bin');
  const callLog = join(fixture.root, 'npm-calls.log');
  mkdirSync(join(fixture.frontendDir, 'node_modules'), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(fixture.frontendDir, 'package-lock.json'), '{}\n');
  writeMockNpm(binDir);

  const result = runScript(fixture.scriptPath, binDir, { NPM_CALL_LOG: callLog });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(callLog, 'utf8').trim().split('\n'), [
    `--prefix ${fixture.frontendDir} ci`,
    `--prefix ${fixture.frontendDir} run build`,
  ]);
  const rendererHtml = readFileSync(
    join(fixture.desktopDir, 'out', 'renderer', 'index.html'),
    'utf8',
  );
  assert.match(rendererHtml, /script-src 'self' 'wasm-unsafe-eval'/);
  assert.doesNotMatch(rendererHtml, /default-src \*/);
  assert.equal(rendererHtml.match(/http-equiv="Content-Security-Policy"/g)?.length, 1);
});

test('renderer build inserts the desktop CSP when the frontend meta tag is absent', (t) => {
  const fixture = makeFixture(t);
  const binDir = join(fixture.root, 'bin');
  const callLog = join(fixture.root, 'npm-calls.log');
  mkdirSync(fixture.frontendDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(fixture.frontendDir, 'package-lock.json'), '{}\n');
  writeMockNpm(binDir, false);

  const result = runScript(fixture.scriptPath, binDir, { NPM_CALL_LOG: callLog });

  assert.equal(result.status, 0, result.stderr);
  const rendererHtml = readFileSync(
    join(fixture.desktopDir, 'out', 'renderer', 'index.html'),
    'utf8',
  );
  assert.match(rendererHtml, /<head>\s*<meta http-equiv="Content-Security-Policy"/);
  assert.match(rendererHtml, /script-src 'self' 'wasm-unsafe-eval'/);
});

for (const mode of ['production', 'development']) {
  for (const custom of [false, true]) {
    test(`renderer ${mode} CSP matches the response policy (${custom ? 'custom' : 'default'} hosts)`, (t) => {
      const fixture = makeFixture(t);
      const binDir = join(fixture.root, 'bin');
      mkdirSync(fixture.frontendDir, { recursive: true });
      mkdirSync(binDir);
      writeFileSync(join(fixture.frontendDir, 'package-lock.json'), '{}\n');
      writeMockNpm(binDir);
      const env = {
        VITE_NODE_ENV: mode,
        VITE_SERVER_URL_PRODUCTION: custom ? 'https://wallet.example/custom-api' : '',
        VITE_SERVER_URL_DEVELOPMENT: custom ? 'https://staging.example/custom-api' : '',
        VITE_EXPLORER_URL_PRODUCTION: custom ? 'https://explorer.example' : '',
        VITE_EXPLORER_URL_DEVELOPMENT: custom ? 'https://explorer.example' : '',
        NPM_CALL_LOG: join(fixture.root, 'npm-calls.log'),
      };
      const result = runScript(fixture.scriptPath, binDir, env);
      assert.equal(result.status, 0, result.stderr);
      const html = readFileSync(join(fixture.desktopDir, 'out/renderer/index.html'), 'utf8');
      const meta = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1];
      assert.ok(meta);
      const metaDirectives = policyDirectives(meta);
      // RPC failover and development/HMR origins are main-only existing
      // connect-src additions. Compare identical inputs for the full policy.
      const connect = metaDirectives.get('connect-src')?.filter((source) => source !== "'self'");
      assert.ok(connect);
      const headerDirectives = policyDirectives(runtimePolicy(env, connect));
      assert.deepEqual(headerDirectives.get('frame-ancestors'), ["'none'"]);
      headerDirectives.delete('frame-ancestors'); // Unsupported in meta policies.
      assert.deepEqual(headerDirectives, metaDirectives);
      const backend = custom
        ? mode === 'production'
          ? 'https://wallet.example'
          : 'https://staging.example'
        : mode === 'production'
          ? 'https://qrlwallet.com'
          : 'https://dev.qrlwallet.com';
      assert.deepEqual(metaDirectives.get('img-src'), ["'self'", 'data:', backend]);
      assert.deepEqual(metaDirectives.get('worker-src'), ["'self'"]);
      assert.match(html, /http-equiv="X-DNS-Prefetch-Control" content="off"/);
      assert.deepEqual(
        [...metaDirectives.keys()],
        [
          'default-src',
          'script-src',
          'style-src',
          'connect-src',
          'img-src',
          'media-src',
          'font-src',
          'object-src',
          'base-uri',
          'form-action',
          'worker-src',
        ],
      );
      for (const [directive, sources] of Object.entries({
        'default-src': ["'self'"],
        'script-src': ["'self'", "'wasm-unsafe-eval'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'media-src': ["'self'", 'blob:'],
        'font-src': ["'self'", 'data:'],
        'object-src': ["'none'"],
        'base-uri': ["'self'"],
        'form-action': ["'self'"],
      }))
        assert.deepEqual(metaDirectives.get(directive), sources);
    });
  }

  test(`renderer ${mode} build supplies API bases and preserves overrides`, (t) => {
    const fixture = makeFixture(t);
    const binDir = join(fixture.root, 'bin');
    const callLog = join(fixture.root, 'npm-calls.log');
    const envLog = join(fixture.root, 'npm-env.log');
    mkdirSync(fixture.frontendDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(fixture.frontendDir, 'package-lock.json'), '{}\n');
    writeMockNpm(binDir);

    const env = {
      NPM_CALL_LOG: callLog,
      NPM_ENV_LOG: envLog,
      VITE_NODE_ENV: mode,
      VITE_SERVER_URL_PRODUCTION: '',
      VITE_SERVER_URL_DEVELOPMENT: '',
    };
    const defaults = runScript(fixture.scriptPath, binDir, env);
    assert.equal(defaults.status, 0, defaults.stderr);
    assert.deepEqual(readFileSync(envLog, 'utf8').trim().split('\n'), [
      'https://qrlwallet.com/api',
      'https://dev.qrlwallet.com/api',
    ]);

    const overridden = runScript(fixture.scriptPath, binDir, {
      ...env,
      VITE_SERVER_URL_PRODUCTION: 'https://wallet.example/custom-api',
      VITE_SERVER_URL_DEVELOPMENT: 'https://staging.example/custom-api',
    });
    assert.equal(overridden.status, 0, overridden.stderr);
    assert.deepEqual(readFileSync(envLog, 'utf8').trim().split('\n'), [
      'https://wallet.example/custom-api',
      'https://staging.example/custom-api',
    ]);
  });
}

test('renderer build fails when copying does not stage index.html', (t) => {
  const fixture = makeFixture(t);
  const binDir = join(fixture.root, 'bin');
  const callLog = join(fixture.root, 'npm-calls.log');
  mkdirSync(fixture.frontendDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(fixture.frontendDir, 'package-lock.json'), '{}\n');
  writeMockNpm(binDir);
  writeFileSync(join(binDir, 'cp'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });

  const result = runScript(fixture.scriptPath, binDir, { NPM_CALL_LOG: callLog });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /ERROR: staged renderer entrypoint missing or empty/);
});
