/**
 * Cross-build guard: when packaging the Windows target from a non-Windows
 * host, npm has only installed the HOST platform's @node-rs/argon2 binding
 * (napi platform packages are os/cpu-filtered optionals). The packaged app
 * then ships without argon2.win32-*.node, the signer utilityProcess dies at
 * startup ("signer exited before ready (code 1)") and the app never shows a
 * window. Force-install the Windows bindings (version-locked to the installed
 * @node-rs/argon2) before electron-builder packs node_modules. No-op on
 * Windows hosts and when the bindings are already present. --no-save keeps
 * package.json and the lockfile untouched.
 */
const { execSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');

if (process.platform === 'win32') process.exit(0);

const version = require('@node-rs/argon2/package.json').version;
const missing = ['x64', 'arm64']
  .map((arch) => `@node-rs/argon2-win32-${arch}-msvc`)
  .filter((pkg) => !existsSync(path.join(__dirname, '..', 'node_modules', pkg)));

if (missing.length > 0) {
  const specs = missing.map((pkg) => `${pkg}@${version}`).join(' ');
  console.log(`[ensure-win-napi] installing foreign-platform bindings: ${specs}`);
  execSync(`npm install --no-save --force ${specs}`, { stdio: 'inherit' });
} else {
  console.log('[ensure-win-napi] Windows argon2 bindings already present');
}
