// Each profile owns a disposable X server. Never inherit the user's display.
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
  throw new Error('Run with env -u DISPLAY -u WAYLAND_DISPLAY npm run test:native:unlock.');
const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = await mkdtemp(path.join(tmpdir(), 'native-unlock-layout-'));
console.log('Native unlock evidence:', evidence);
const results = [];
for (const size of ['1024x768', '1280x720']) {
  for (const scale of [1, 1.25]) {
    const name = `${size}-${scale}`;
    const result = await new Promise((resolve, reject) => {
      const child = spawn(
        'xvfb-run',
        [
          '-a',
          '-s',
          `-screen 0 ${size}x24 -dpi 96`,
          process.execPath,
          '--import',
          'tsx',
          'scripts/native-unlock-app.mjs',
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            QRL_UNLOCK_EVIDENCE: evidence,
            QRL_UNLOCK_SIZE: size,
            QRL_UNLOCK_SCALE: String(scale),
            GDK_BACKEND: 'x11',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 300000,
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
      child.on('close', (code) => resolve({ name, code, stdout, stderr }));
    });
    await writeFile(path.join(evidence, `${name}.log`), result.stdout + result.stderr);
    results.push({ name, code: result.code });
    await writeFile(path.join(evidence, 'gates.json'), JSON.stringify(results, null, 2));
    process.stdout.write(result.stdout);
    if (result.code !== 0) throw new Error(`${name} failed (${result.code}): ${result.stderr}`);
  }
}
console.log('PASS: unlock and settings in five languages, two work areas, 100% and 125% text.');
