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
# This is a PRODUCTION build by default: the bundled renderer targets
# qrlwallet.com. The frontend picks its backend/RPC/explorer from
# VITE_NODE_ENV + VITE_*_PRODUCTION/_DEVELOPMENT (frontend
# src/config/networks.ts). Each var is overridable: a value already in the
# environment wins, so a staging build exports VITE_NODE_ENV=development
# (dev vars default to dev.qrlwallet.com below) plus the QRL_* runtime env
# for the main process. Keep the desktop main-process CSP allowlist
# (src/main/config.ts frontendOrigins) in sync with these origins.
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

# PRODUCTION defaults (qrlwallet.com). ${VAR:-default} keeps any value the
# caller already exported, so a staging build just exports
# VITE_NODE_ENV=development plus the *_DEVELOPMENT vars (dev.qrlwallet.com)
# and matching QRL_* runtime env for the main process (src/main/config.ts).
export VITE_DESKTOP=1
export VITE_NODE_ENV="${VITE_NODE_ENV:-production}"
# The RPC endpoint is the backend's JSON-RPC PROXY, not the bare host: the
# frontend builds the provider URL as `${VITE_RPC_URL_PRODUCTION}/testnet`
# (config/networks.ts), and the proxy lives at /api/qrl-rpc, so the live URL is
# https://qrlwallet.com/api/qrl-rpc/testnet. Pointing at the bare host makes
# the frontend POST to /testnet, which the edge answers 405 ("Connection failed").
export VITE_RPC_URL_PRODUCTION="${VITE_RPC_URL_PRODUCTION:-https://qrlwallet.com/api/qrl-rpc}"
export VITE_SERVER_URL_PRODUCTION="${VITE_SERVER_URL_PRODUCTION:-https://qrlwallet.com}"
export VITE_EXPLORER_URL_PRODUCTION="${VITE_EXPLORER_URL_PRODUCTION:-https://zondscan.com}"
# Staging fallbacks used when VITE_NODE_ENV=development is exported.
export VITE_RPC_URL_DEVELOPMENT="${VITE_RPC_URL_DEVELOPMENT:-https://dev.qrlwallet.com/api/qrl-rpc}"
export VITE_SERVER_URL_DEVELOPMENT="${VITE_SERVER_URL_DEVELOPMENT:-https://dev.qrlwallet.com}"
export VITE_EXPLORER_URL_DEVELOPMENT="${VITE_EXPLORER_URL_DEVELOPMENT:-https://zondscan.com}"

echo "[build-renderer] building frontend (VITE_DESKTOP=1, VITE_NODE_ENV=${VITE_NODE_ENV})..."
if [[ "${VITE_NODE_ENV}" == "production" ]]; then
  echo "[build-renderer]   server/RPC -> ${VITE_SERVER_URL_PRODUCTION}, explorer -> ${VITE_EXPLORER_URL_PRODUCTION}"
else
  echo "[build-renderer]   server/RPC -> ${VITE_SERVER_URL_DEVELOPMENT}, explorer -> ${VITE_EXPLORER_URL_DEVELOPMENT}"
fi
# VITE_DESKTOP=1 -> base './' for file://. The router switches to hash routing
# at runtime via window.qrlWallet, so nothing else is needed.
npm --prefix "${FRONTEND_DIR}" run build

FRONTEND_DIST="${FRONTEND_DIR}/dist"
if [[ ! -f "${FRONTEND_DIST}/index.html" ]]; then
  echo "[build-renderer] ERROR: expected ${FRONTEND_DIST}/index.html, not found." >&2
  exit 1
fi

echo "[build-renderer] staging build into ${OUT_RENDERER}"
rm -rf "${OUT_RENDERER}"
mkdir -p "${OUT_RENDERER}"
cp -R "${FRONTEND_DIST}/." "${OUT_RENDERER}/"

# The reused frontend ships a <meta http-equiv="Content-Security-Policy"> tuned
# for WEB hosting: script-src carries 'unsafe-inline' and connect-src allows
# http://localhost:* (both fine behind nginx's strict header, wrong for the
# desktop). The desktop's authoritative CSP is now delivered as a real response
# header by the file-protocol handler (src/main/index.ts), but the meta tag
# stays enforced too, so rewrite it WHOLESALE to the desktop policy: no inline
# script, no localhost connects, connect-src limited to the configured backend
# + relay + explorer. Mirror src/main/security.ts buildContentSecurityPolicy,
# minus frame-ancestors (ignored in meta CSP). Idempotent, portable sed (no
# in-place -i, which differs on BSD/macOS).
RENDER_HTML="${OUT_RENDERER}/index.html"
if [[ "${VITE_NODE_ENV}" == "production" ]]; then
  CSP_SERVER_URL="${VITE_SERVER_URL_PRODUCTION:-${VITE_SERVER_URL_DEVELOPMENT}}"
  CSP_EXPLORER_URL="${VITE_EXPLORER_URL_PRODUCTION:-${VITE_EXPLORER_URL_DEVELOPMENT}}"
else
  CSP_SERVER_URL="${VITE_SERVER_URL_DEVELOPMENT}"
  CSP_EXPLORER_URL="${VITE_EXPLORER_URL_DEVELOPMENT}"
fi
SERVER_HOST="$(printf '%s' "${CSP_SERVER_URL}" | sed -E 's#^https?://##; s#/.*$##')"
EXPLORER_HOST="$(printf '%s' "${CSP_EXPLORER_URL}" | sed -E 's#^https?://##; s#/.*$##')"
# qrlwallet.com https+wss is the dApp-connect relay, reached directly even by
# the dev/staging frontend (keep in sync with src/main/config.ts frontendOrigins).
DESKTOP_CSP="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://${SERVER_HOST} wss://${SERVER_HOST} https://qrlwallet.com wss://qrlwallet.com https://${EXPLORER_HOST}; img-src 'self' data: https:; media-src 'self' blob:; font-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'; worker-src 'self' blob:"
# Distinguish the two skip reasons so the warning is never misleading: an empty
# SERVER_HOST (misconfigured env) is a different problem from a genuinely absent
# meta tag. Either way the header CSP (main process) remains authoritative.
if [[ -z "${SERVER_HOST}" ]]; then
  echo "[build-renderer] WARNING: no server host resolved from VITE_SERVER_URL_*; skipping meta CSP rewrite (header CSP still applies)" >&2
elif grep -q '<meta http-equiv="Content-Security-Policy"' "${RENDER_HTML}"; then
  echo "[build-renderer] rewriting renderer meta CSP to the desktop policy (script-src 'self', backend ${SERVER_HOST})"
  sed -E "s#<meta http-equiv=\"Content-Security-Policy\"[^>]*>#<meta http-equiv=\"Content-Security-Policy\" content=\"${DESKTOP_CSP}\">#" "${RENDER_HTML}" > "${RENDER_HTML}.tmp" \
    && mv "${RENDER_HTML}.tmp" "${RENDER_HTML}"
else
  echo "[build-renderer] WARNING: meta CSP tag not found in ${RENDER_HTML}; header CSP (main process) is the only policy" >&2
fi

echo "[build-renderer] done. Real frontend staged at ${OUT_RENDERER}/index.html"
