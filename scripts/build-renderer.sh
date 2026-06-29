#!/usr/bin/env bash
#
# build-renderer.sh
#
# Builds the REAL ../myqrlwallet-frontend React app as the desktop renderer and
# stages it at out/renderer/, loaded by the main process via loadFile().
#
# This is the "easy updates" backbone: it always builds the CURRENT frontend
# checkout (the submodule), so updating the frontend = bump the submodule and
# re-run this. The frontend source is NEVER copied/vendored into this repo, so
# it cannot drift.
#
# The frontend needs exactly two desktop adaptations, both already in the
# frontend repo and BOTH web-safe:
#   1. Vite `base: './'` under file:// - driven here by VITE_DESKTOP=1
#      (config/vite.config.ts reads it; web builds keep '/').
#   2. createBrowserRouter -> createHashRouter under file:// - handled at
#      RUNTIME in the frontend (router.tsx detects window.qrlWallet), so no
#      build flag and no post-build HTML surgery is needed.
#
# Exits 0 with guidance if the frontend dir is absent.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
FRONTEND_DIR="$(cd "${DESKTOP_DIR}/.." && pwd)/myqrlwallet-frontend"
OUT_RENDERER="${DESKTOP_DIR}/out/renderer"

echo "[build-renderer] frontend dir: ${FRONTEND_DIR}"
echo "[build-renderer] out renderer: ${OUT_RENDERER}"

if [[ ! -d "${FRONTEND_DIR}" ]]; then
  echo "[build-renderer] WARNING: frontend not found at ${FRONTEND_DIR}." >&2
  echo "[build-renderer] Initialise the submodule (git submodule update --init" >&2
  echo "[build-renderer] ../myqrlwallet-frontend) then re-run. Skipping." >&2
  exit 0
fi

if [[ ! -d "${FRONTEND_DIR}/node_modules" ]]; then
  echo "[build-renderer] installing frontend dependencies..."
  npm --prefix "${FRONTEND_DIR}" install
fi

echo "[build-renderer] building frontend (VITE_DESKTOP=1)..."
# VITE_DESKTOP=1 -> base './' for file://. The router switches to hash routing
# at runtime via window.qrlWallet, so nothing else is needed.
VITE_DESKTOP=1 npm --prefix "${FRONTEND_DIR}" run build

FRONTEND_DIST="${FRONTEND_DIR}/dist"
if [[ ! -f "${FRONTEND_DIST}/index.html" ]]; then
  echo "[build-renderer] ERROR: expected ${FRONTEND_DIST}/index.html, not found." >&2
  exit 1
fi

echo "[build-renderer] staging build into ${OUT_RENDERER}"
rm -rf "${OUT_RENDERER}"
mkdir -p "${OUT_RENDERER}"
cp -R "${FRONTEND_DIST}/." "${OUT_RENDERER}/"

echo "[build-renderer] done. Real frontend staged at ${OUT_RENDERER}/index.html"
