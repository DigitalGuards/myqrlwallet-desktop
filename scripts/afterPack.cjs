// @ts-check
'use strict';

/*
 * electron-builder `afterPack` hook (CommonJS, loaded via require()).
 *
 * Context shape (electron-builder 26.x AfterPackContext):
 *   {
 *     appOutDir: string,              // dir holding the packaged app for this target
 *     outDir: string,                 // top-level release/ output dir
 *     arch: number,                   // Arch enum (ia32=0, x64=1, armv7l=2, arm64=3, universal=4)
 *     electronPlatformName: string,   // 'darwin' | 'win32' | 'linux'
 *     targets: Target[],
 *     packager: {
 *       appInfo: { productFilename: string, ... },
 *       platform: { ... },
 *       ...
 *     }
 *   }
 *
 * This runs AFTER electron-builder lays out the unsigned app but BEFORE code
 * signing, which is exactly when we must flip @electron/fuses: the fuse byte is
 * baked into the binary and must be final before the signature is computed,
 * otherwise the later signature would be invalidated. On macOS we therefore set
 * resetAdHocDarwinSignature:true so flipFuses re-seals the ad-hoc signature and
 * electron-builder's subsequent real signing stays valid.
 */

const path = require('node:path');
const fs = require('node:fs');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

/**
 * Resolve the per-platform Electron binary inside the packaged app dir.
 * @param {string} platform electronPlatformName ('darwin' | 'win32' | 'linux')
 * @param {string} appOutDir
 * @param {string} productFilename
 * @returns {string}
 */
function resolveElectronBinary(platform, appOutDir, productFilename) {
  if (platform === 'darwin') {
    return path.join(appOutDir, `${productFilename}.app`, 'Contents', 'MacOS', productFilename);
  }
  if (platform === 'win32') {
    return path.join(appOutDir, `${productFilename}.exe`);
  }
  // linux: the binary has no extension and electron-builder lowercases it.
  return path.join(appOutDir, productFilename);
}

/**
 * @param {import('electron-builder').AfterPackContext} context
 */
exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName;
  const productFilename = context.packager.appInfo.productFilename;
  const isMac = platform === 'darwin';

  const electronBinary = resolveElectronBinary(platform, context.appOutDir, productFilename);

  if (!fs.existsSync(electronBinary)) {
    console.warn(`[afterPack] fuses skipped: binary not found at ${electronBinary}`);
    return;
  }

  console.log(`[afterPack] flipping @electron/fuses on ${electronBinary}`);

  try {
    await flipFuses(electronBinary, {
      version: FuseVersion.V1,
      // Forbid running the bundled Electron as a plain Node.js process.
      [FuseV1Options.RunAsNode]: false,
      // Ignore NODE_OPTIONS so an attacker cannot inject startup flags.
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      // Reject --inspect / --inspect-brk debugger attach in production.
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      // Verify the embedded ASAR against its integrity hash at load time.
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      // Refuse to load app code from anywhere except the signed app.asar.
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      // Encrypt the cookie store at rest (defense-in-depth, no secrets there).
      [FuseV1Options.EnableCookieEncryption]: true,
      // macOS: re-seal the ad-hoc signature so the real signing step is valid.
      resetAdHocDarwinSignature: isMac,
    });
    console.log(
      '[afterPack] fuses set: RunAsNode=off NodeOptions=off NodeCliInspect=off ' +
        'AsarIntegrity=on OnlyLoadAppFromAsar=on CookieEncryption=on' +
        (isMac ? ' (ad-hoc signature reset)' : ''),
    );
  } catch (err) {
    // Be defensive: a fuse failure should surface loudly but with context.
    console.error(
      `[afterPack] flipFuses failed for ${electronBinary}:`,
      err instanceof Error ? err.message : err,
    );
    throw err;
  }
};
