/**
 * Minimal main-process file logger.
 *
 * The packaged app is a GUI process: console.log goes nowhere on Windows and
 * renderer DevTools are fused off, so field failures (dead protocol launches,
 * signer exits) were invisible. This appends one line per event to
 * userData/logs/main.log (~%APPDATA%/MyQRLWallet/logs/main.log on Windows)
 * and mirrors to console for dev / --enable-logging runs.
 *
 * PRIVACY: callers must never log secrets or full URIs; log lengths and
 * decisions, not contents. Logging must never break the app: every fs error
 * is swallowed. Volume is a handful of lines per session, so synchronous
 * appends are fine and keep ordering exact.
 */
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

const MAX_BYTES = 1024 * 1024; // rotate to .1 past 1MB; one spare generation

let resolvedPath: string | null | undefined;

function logFilePath(): string | null {
  if (resolvedPath !== undefined) return resolvedPath;
  try {
    // userData derives from appData + app name (set before this runs) and is
    // available before app ready.
    const dir = path.join(app.getPath('userData'), 'logs');
    mkdirSync(dir, { recursive: true });
    resolvedPath = path.join(dir, 'main.log');
  } catch {
    resolvedPath = null;
  }
  return resolvedPath;
}

export function logMain(message: string): void {
  const line = `${new Date().toISOString()} ${message}`;
  console.log(line);
  const file = logFilePath();
  if (!file) return;
  try {
    try {
      if (statSync(file).size > MAX_BYTES) {
        rmSync(`${file}.1`, { force: true });
        renameSync(file, `${file}.1`);
      }
    } catch {
      /* first write: no file to rotate */
    }
    appendFileSync(file, `${line}\n`);
  } catch {
    /* logging must never break the app */
  }
}
