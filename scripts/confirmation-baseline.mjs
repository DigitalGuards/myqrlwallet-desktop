import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildSync } from 'esbuild';

export const baselineRevision = '0a6d581';
export const root = path.resolve(import.meta.dirname, '..');

/** Load the release summariser from Git without changing the worktree. */
export function loadBaseline() {
  const directory = mkdtempSync(path.join(tmpdir(), 'confirmation-baseline-'));
  try {
    const outfile = path.join(directory, 'summary.cjs');
    buildSync({
      stdin: {
        contents: execFileSync('git', ['show', `${baselineRevision}:src/main/confirmSummary.ts`], {
          cwd: root,
          encoding: 'utf8',
        }),
        resolveDir: path.join(root, 'src/main'),
        loader: 'ts',
      },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile,
    });
    return createRequire(import.meta.url)(outfile);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
