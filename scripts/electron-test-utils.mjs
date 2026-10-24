import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

export function electronTestArgs(application, frontend = process.env.QRL_FRONTEND_DIR) {
  assert.ok(frontend, 'Set QRL_FRONTEND_DIR for Playwright');
  const require = createRequire(path.join(frontend, 'package.json'));
  // An explicit executablePath skips Playwright's loader. Load it explicitly so
  // app readiness waits for debugger attachment, including the short-lived helpers.
  const loader = path.join(
    path.dirname(require.resolve('playwright-core/package.json')),
    'lib/server/electron/loader.js',
  );
  return ['-r', loader, application];
}

export async function waitForAppPage(app, url = 'app://wallet/index.html') {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const page = app
      .context()
      .pages()
      .find((candidate) => candidate.url().split('#')[0] === url);
    if (page) {
      await page.waitForLoadState('domcontentloaded');
      return page;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

export async function isolatedEnvironment(profile) {
  assert.match(process.env.DISPLAY ?? '', /^:(?!0(?:\.|$))\d+/);
  assert.ok(
    !process.env.WAYLAND_DISPLAY,
    'Use env -u DISPLAY -u WAYLAND_DISPLAY and a private Xvfb',
  );
  const env = { LANG: 'en_US.UTF-8', QRL_RPC_URL_SECONDARY: 'none' };
  for (const key of ['PATH', 'DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR']) {
    env[key] = path.join(profile, key.toLowerCase());
    await mkdir(env[key], { recursive: true, mode: 0o700 });
  }
  return env;
}
