#!/usr/bin/env bash
#
# build-renderer.sh
#
# Builds the REAL ../myqrlwallet-frontend React app as the production renderer
# bundle for the Electron shell, then copies the result into out/renderer/.
#
# Two Electron-specific overrides are required for the frontend to work when
# loaded from disk via loadFile() (file:// origin):
#
#   1. Vite base must be './' so asset URLs are relative, not absolute '/assets/'
#      (absolute paths resolve to the filesystem root under file:// and 404).
#      We apply this WITHOUT mutating the frontend repo by rewriting the built
#      dist/index.html in place (sed: '/assets/ -> ./assets/').
#
#   2. createBrowserRouter -> createHashRouter. The HTML5 history API does not
#      work under file://, so deep links / route reloads break. This is a SOURCE
#      change in the frontend (router.tsx) and CANNOT be safely faked from the
#      build output. We print a loud WARNING; it must be applied in the frontend
#      repo for deep links to work. The app's initial route still loads without
#      it, so the build does not fail on this account.
#
# The script is idempotent, never permanently mutates the frontend repo, and
# exits 0 (with guidance) if the frontend directory is absent.

set -euo pipefail

# Resolve paths relative to this script so it works from any CWD.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
FRONTEND_DIR="$(cd "${DESKTOP_DIR}/.." && pwd)/myqrlwallet-frontend"
OUT_RENDERER="${DESKTOP_DIR}/out/renderer"

echo "[build-renderer] desktop dir : ${DESKTOP_DIR}"
echo "[build-renderer] frontend dir: ${FRONTEND_DIR}"
echo "[build-renderer] out renderer: ${OUT_RENDERER}"

if [[ ! -d "${FRONTEND_DIR}" ]]; then
  echo ""
  echo "[build-renderer] WARNING: frontend not found at ${FRONTEND_DIR}"
  echo "[build-renderer] Clone DigitalGuards/myqrlwallet-frontend next to this"
  echo "[build-renderer] repo, then re-run: npm run build:renderer:frontend"
  echo "[build-renderer] Skipping (the dev placeholder renderer will be used)."
  exit 0
fi

echo "[build-renderer] installing frontend dependencies..."
npm --prefix "${FRONTEND_DIR}" install

echo "[build-renderer] building frontend (vite)..."
npm --prefix "${FRONTEND_DIR}" run build

FRONTEND_DIST="${FRONTEND_DIR}/dist"
if [[ ! -d "${FRONTEND_DIST}" ]]; then
  echo "[build-renderer] ERROR: expected build output at ${FRONTEND_DIST}, not found." >&2
  exit 1
fi

# --- Override 1: rewrite absolute /assets/ to ./assets/ in the built HTML ----
# This is the safe, non-repo-mutating equivalent of setting Vite base './'.
INDEX_HTML="${FRONTEND_DIST}/index.html"
if [[ -f "${INDEX_HTML}" ]]; then
  echo "[build-renderer] rewriting absolute asset paths to relative in index.html"
  # Match src="/assets/ and href="/assets/ (double or single quotes).
  sed -i.bak -E 's#(src|href)=(["'"'"'])/assets/#\1=\2./assets/#g' "${INDEX_HTML}"
  rm -f "${INDEX_HTML}.bak"
fi

# --- Override 2: router caveat (cannot be done safely from build output) ------
echo ""
echo "============================================================================"
echo "[build-renderer] WARNING: createBrowserRouter -> createHashRouter NOT applied"
echo "[build-renderer] This is a SOURCE change in the frontend repo:"
echo "[build-renderer]     myqrlwallet-frontend/src/router.tsx (around line 47)"
echo "[build-renderer] Without it, deep links and route reloads break under file://"
echo "[build-renderer] because the HTML5 history API is unavailable. The initial"
echo "[build-renderer] route still loads, so this build proceeds. Apply the change"
echo "[build-renderer] in the frontend repo for full deep-link support."
echo "============================================================================"
echo ""

# --- Copy dist/* into out/renderer/ (idempotent) -----------------------------
echo "[build-renderer] copying build into ${OUT_RENDERER}"
rm -rf "${OUT_RENDERER}"
mkdir -p "${OUT_RENDERER}"
cp -R "${FRONTEND_DIST}/." "${OUT_RENDERER}/"

echo "[build-renderer] done. Renderer bundle staged at ${OUT_RENDERER}"
