// @ts-check
'use strict';

/*
 * electron-builder `afterSign` hook (CommonJS, loaded via require()).
 *
 * Context shape (electron-builder 26.x AfterPackContext, same object as
 * afterPack):
 *   {
 *     appOutDir: string,
 *     outDir: string,
 *     arch: number,
 *     electronPlatformName: string,   // 'darwin' | 'win32' | 'linux'
 *     packager: { appInfo: { productFilename: string, ... }, ... }
 *   }
 *
 * afterSign runs once electron-builder has code-signed the app. We notarize
 * only the macOS .app via Apple's notarytool. Authentication uses an App Store
 * Connect API key (APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER). If
 * those are absent we log and return so unsigned local builds still complete
 * instead of throwing.
 *
 * Note: electron-builder.yml also sets mac.notarize: true. Keep only ONE
 * notarization path active to avoid double submission. This hook is the
 * explicit, env-gated path; if you rely on it, set mac.notarize: false. It is
 * left here so the hook contract documented in ARCHITECTURE_RESEARCH.md is
 * satisfied and so notarization degrades gracefully without the env vars.
 */

const path = require('node:path');
const { notarize } = require('@electron/notarize');

/**
 * @param {import('electron-builder').AfterPackContext} context
 */
exports.default = async function notarizeHook(context) {
  if (context.electronPlatformName !== 'darwin') {
    return;
  }

  const { APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER } = process.env;
  if (!APPLE_API_KEY || !APPLE_API_KEY_ID || !APPLE_API_ISSUER) {
    console.log('[notarize] skipping notarization (no APPLE_API_* env)');
    return;
  }

  const productFilename = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${productFilename}.app`);

  console.log(`[notarize] submitting ${appPath} to notarytool`);

  await notarize({
    tool: 'notarytool',
    appPath,
    appleApiKey: APPLE_API_KEY,
    appleApiKeyId: APPLE_API_KEY_ID,
    appleApiIssuer: APPLE_API_ISSUER,
  });

  console.log(`[notarize] notarization complete for ${appPath}`);
};
