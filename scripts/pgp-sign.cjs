// @ts-check
'use strict';

/*
 * electron-builder `afterAllArtifactBuild` hook (CommonJS, loaded via
 * require()).
 *
 * Argument shape (electron-builder 26.x BuildResult):
 *   {
 *     outDir: string,
 *     artifactPaths: string[],   // every built artifact (.dmg, .zip, .exe,
 *                                // .AppImage, .deb, .rpm, .blockmap, ...)
 *     platformToTargets: Map,
 *     configuration: Configuration
 *   }
 *
 * Returning an array of additional file paths tells electron-builder to treat
 * them as build artifacts too (so a publisher would upload them). We PGP
 * detach-sign every real artifact into a <path>.asc sidecar, mirroring Railway
 * Wallet's signed Linux artifact set, and return the list of .asc files.
 *
 * Signing key is selected by GPG_KEY_ID (a key id, fingerprint, or uid). If it
 * is unset we log a skip and return [] so local/dev builds still succeed.
 */

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

/**
 * @param {{ artifactPaths: string[] }} buildResult
 * @returns {Promise<string[]>}
 */
exports.default = async function pgpSign(buildResult) {
  const keyId = process.env.GPG_KEY_ID;
  if (!keyId) {
    console.log('[pgp-sign] skipping PGP signing (no GPG_KEY_ID env)');
    return [];
  }

  /** @type {string[]} */
  const signed = [];

  for (const artifactPath of buildResult.artifactPaths) {
    // Never sign sidecars or update metadata: only the primary artifacts.
    if (artifactPath.endsWith('.asc') || artifactPath.endsWith('.blockmap')) {
      continue;
    }
    if (!fs.existsSync(artifactPath)) {
      console.warn(`[pgp-sign] artifact missing, skipped: ${artifactPath}`);
      continue;
    }

    const ascPath = `${artifactPath}.asc`;
    try {
      execFileSync(
        'gpg',
        [
          '--batch',
          '--yes',
          '--detach-sign',
          '--armor',
          '--local-user',
          keyId,
          '--output',
          ascPath,
          artifactPath,
        ],
        { stdio: ['ignore', 'inherit', 'inherit'] },
      );
      console.log(`[pgp-sign] signed ${artifactPath} -> ${ascPath}`);
      signed.push(ascPath);
    } catch (err) {
      console.error(
        `[pgp-sign] failed to sign ${artifactPath}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return signed;
};
