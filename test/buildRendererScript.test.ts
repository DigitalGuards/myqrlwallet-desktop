import { spawnSync } from 'node:child_process';
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

function writeMockNpm(binDir: string) {
  const npmPath = join(binDir, 'npm');
  writeFileSync(
    npmPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$NPM_CALL_LOG"
if [[ "$3" == "run" && "$4" == "build" ]]; then
  mkdir -p "$2/dist"
  printf '%s\\n' '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src *"><main>renderer</main>' > "$2/dist/index.html"
fi
`,
    { mode: 0o755 },
  );
}

function runScript(scriptPath: string, binDir?: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const path = binDir ? `${binDir}:${process.env.PATH ?? ''}` : process.env.PATH;
  return spawnSync('bash', [scriptPath], {
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv, PATH: path },
  });
}

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
});

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
