import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';
import { visibilityCases } from '../test/confirmationVisibilityFixtures.ts';
import { loadBaseline, root } from './confirmation-baseline.mjs';

// Every run owns its X server. Refuse an inherited desktop display, including Wayland.
if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
  throw new Error('Run with env -u DISPLAY -u WAYLAND_DISPLAY npm run test:native:confirm.');
const require = createRequire(import.meta.url);
const baselineOnly = process.argv.includes('--baseline-only');
const headingOnly = process.argv.includes('--heading-only');
if (headingOnly && !baselineOnly) throw new Error('--heading-only requires --baseline-only.');
const directory = mkdtempSync(path.join(tmpdir(), 'confirmation-visibility-'));
console.log('Native visibility evidence:', directory);
const include = [
  process.env.NODE_INCLUDE_DIR,
  '/usr/include/node',
  path.join(homedir(), '.cache', 'node-gyp', process.versions.node, 'include', 'node'),
].find((entry) => entry && existsSync(path.join(entry, 'node_api.h')));
if (!include)
  throw new Error('Node C headers required: set NODE_INCLUDE_DIR or install libnode-dev.');
execFileSync('cc', [
  '-shared',
  '-fPIC',
  '-I' + include,
  path.join(root, 'scripts/measure-confirmation.c'),
  '-o',
  path.join(directory, 'measure.node'),
  '-ldl',
]);
buildSync({
  entryPoints: [path.join(root, 'src/main/confirm.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  outfile: path.join(directory, 'confirm.cjs'),
});
const baseline = loadBaseline();
writeFileSync(
  path.join(directory, 'cases.json'),
  JSON.stringify(
    visibilityCases
      .filter(
        (fixture) =>
          fixture.request.kind === 'transaction' &&
          (!headingOnly || fixture.name === 'transaction 80 digit heading'),
      )
      .map((fixture) => {
        const summary = baseline.summariseSignatureRequest(fixture.request, fixture.context);
        return {
          ...fixture,
          legacy: {
            ...summary,
            pages: headingOnly
              ? ['Amount: 1 Quanta']
              : summary.pages.map((page) =>
                  baseline.wrapDetailText(`${page}\n\n${baseline.SIGNATURE_APPROVAL_NOTE}`),
                ),
          },
        };
      }),
  ),
);
const profiles = ['1024x768', '1280x720'].flatMap((size) =>
  [8, 9, 10, 11, 12].flatMap((points) => [1, 1.25].map((scale) => ({ size, points, scale }))),
);
const selected = process.argv.indexOf('--profile');
const jobs =
  selected < 0
    ? profiles
    : profiles.filter(
        ({ size, points, scale }) => `${size}:${points}:${scale}` === process.argv[selected + 1],
      );
if (jobs.length === 0) throw new Error('Unknown --profile; use WORKAREAxHEIGHT:POINTS:SCALE.');
async function run({ size, points, scale }) {
  const profile = path.join(directory, `${size}-${points}pt-${scale}`);
  const config = path.join(profile, 'config');
  mkdirSync(path.join(config, 'gtk-3.0'), { recursive: true });
  writeFileSync(
    path.join(config, 'gtk-3.0/settings.ini'),
    `[Settings]\ngtk-font-name=DejaVu Sans ${points}\n`,
  );
  const result = await new Promise((resolve, reject) => {
    const child = spawn(
      'xvfb-run',
      [
        '-a',
        '-s',
        `-screen 0 ${size}x24 -dpi 96`,
        require('electron'),
        '--gtk-version=3',
        path.join(root, 'scripts/confirmation-visibility-app.cjs'),
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          CONFIRMATION_TEST_DIR: directory,
          CONFIRMATION_PROFILE_DIR: profile,
          CONFIRMATION_WORK_AREA: size,
          CONFIRMATION_TEXT_SCALE: String(scale),
          CONFIRMATION_BASELINE_ONLY: baselineOnly ? '1' : '0',
          XDG_CONFIG_HOME: config,
          XDG_CACHE_HOME: path.join(profile, 'cache'),
          GSETTINGS_BACKEND: 'memory',
          GDK_BACKEND: 'x11',
          GDK_SCALE: '1',
          GDK_DPI_SCALE: String(scale),
        },
        timeout: 180000,
      },
    );
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (data) => {
      stdout += data;
    });
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  writeFileSync(path.join(profile, 'electron.log'), result.stderr);
  process.stdout.write(result.stdout);
  if (result.code !== 0)
    throw new Error(`${path.basename(profile)} failed (${result.code}): ${result.stderr}`);
}
// Independent virtual displays keep the complete sweep practical as a local check.
const started = performance.now();
for (let index = 0; index < jobs.length; index += 2) {
  const results = await Promise.allSettled(jobs.slice(index, index + 2).map(run));
  const failure = results.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
}
console.log(
  `${baselineOnly ? 'Baseline measurement' : 'Native visibility check'}: ${jobs.length} profiles completed in ${((performance.now() - started) / 1000).toFixed(1)}s`,
);
