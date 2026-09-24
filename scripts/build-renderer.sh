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
# Fails with guidance if the frontend source or lockfile is absent.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
FRONTEND_DIR="$(cd "${DESKTOP_DIR}/.." && pwd)/myqrlwallet-frontend"
OUT_RENDERER="${DESKTOP_DIR}/out/renderer"

echo "[build-renderer] frontend dir: ${FRONTEND_DIR}"
echo "[build-renderer] out renderer: ${OUT_RENDERER}"

if [[ ! -d "${FRONTEND_DIR}" ]]; then
  echo "[build-renderer] ERROR: frontend not found at ${FRONTEND_DIR}." >&2
  echo "[build-renderer] Initialise the submodule (git submodule update --init" >&2
  echo "[build-renderer] ../myqrlwallet-frontend) then re-run." >&2
  exit 1
fi

if [[ ! -f "${FRONTEND_DIR}/package-lock.json" ]]; then
  echo "[build-renderer] ERROR: frontend lockfile not found at ${FRONTEND_DIR}/package-lock.json." >&2
  exit 1
fi

echo "[build-renderer] installing locked frontend dependencies..."
npm --prefix "${FRONTEND_DIR}" ci

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
# SERVER_URL is an API base; history and IPFS consumers append their own paths.
export VITE_SERVER_URL_PRODUCTION="${VITE_SERVER_URL_PRODUCTION:-https://qrlwallet.com/api}"
export VITE_EXPLORER_URL_PRODUCTION="${VITE_EXPLORER_URL_PRODUCTION:-https://zondscan.com}"
# Staging fallbacks used when VITE_NODE_ENV=development is exported.
export VITE_RPC_URL_DEVELOPMENT="${VITE_RPC_URL_DEVELOPMENT:-https://dev.qrlwallet.com/api/qrl-rpc}"
export VITE_SERVER_URL_DEVELOPMENT="${VITE_SERVER_URL_DEVELOPMENT:-https://dev.qrlwallet.com/api}"
export VITE_EXPLORER_URL_DEVELOPMENT="${VITE_EXPLORER_URL_DEVELOPMENT:-https://zondscan.com}"

# The renderer and native broker ship the same qualified v3 network identity.
export VITE_WALLET_PROFILE=v3-private
export VITE_V3_CHAIN_ID=0x301825
export VITE_V3_GENESIS_HASH=0xd15407991193e6c23b733dc6bf9c628deaff8f9b6e252aa0d60030952b3e3ea4
if [[ "${VITE_NODE_ENV}" == "production" ]]; then
  export VITE_V3_RPC_URL="${VITE_RPC_URL_PRODUCTION}/testnet"
  export VITE_V3_SERVER_URL="${VITE_SERVER_URL_PRODUCTION}"
  export VITE_V3_EXPLORER_URL="${VITE_EXPLORER_URL_PRODUCTION}"
else
  export VITE_V3_RPC_URL="${VITE_RPC_URL_DEVELOPMENT}/testnet"
  export VITE_V3_SERVER_URL="${VITE_SERVER_URL_DEVELOPMENT}"
  export VITE_V3_EXPLORER_URL="${VITE_EXPLORER_URL_DEVELOPMENT}"
fi

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

RENDER_HTML="${OUT_RENDERER}/index.html"
if [[ ! -s "${RENDER_HTML}" ]]; then
  echo "[build-renderer] ERROR: staged renderer entrypoint missing or empty at ${RENDER_HTML}." >&2
  exit 1
fi

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
DESKTOP_CSP="default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://${SERVER_HOST} wss://${SERVER_HOST} https://qrlwallet.com wss://qrlwallet.com https://${EXPLORER_HOST}; img-src 'self' data: https:; media-src 'self' blob:; font-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'; worker-src 'self' blob:"
if [[ -z "${SERVER_HOST}" || -z "${EXPLORER_HOST}" ]]; then
  echo "[build-renderer] ERROR: could not resolve the CSP server and explorer hosts" >&2
  exit 1
fi

# Vite/Prettier may serialize the source meta tag over several lines. Use Node's
# HTML-text rewrite rather than line-oriented sed so the desktop policy always
# replaces that complete tag. If a future frontend removes its web meta policy,
# insert the desktop policy into <head> and preserve defense in depth.
CSP_REWRITE_ACTION="$(node - "${RENDER_HTML}" "${DESKTOP_CSP}" <<'NODE'
const fs = require('node:fs');

const [htmlPath, csp] = process.argv.slice(2);
if (!htmlPath || !csp) throw new Error('renderer CSP rewrite arguments are missing');

let html = fs.readFileSync(htmlPath, 'utf8');
const escapedCsp = csp.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${escapedCsp}">`;
const cspMetaPattern =
  /<meta\b(?=[^>]*\bhttp-equiv\s*=\s*(["'])Content-Security-Policy\1)[^>]*>/i;

let action;
if (cspMetaPattern.test(html)) {
  html = html.replace(cspMetaPattern, cspMeta);
  action = 'rewrote';
} else {
  const headPattern = /<head\b[^>]*>/i;
  if (!headPattern.test(html)) throw new Error('renderer HTML has no <head> element');
  html = html.replace(headPattern, (head) => `${head}\n    ${cspMeta}`);
  action = 'inserted';
}

fs.writeFileSync(htmlPath, html);
process.stdout.write(action);
NODE
)"
echo "[build-renderer] ${CSP_REWRITE_ACTION} renderer meta CSP (script-src 'self' 'wasm-unsafe-eval', backend ${SERVER_HOST})"

echo "[build-renderer] done. Real frontend staged at ${OUT_RENDERER}/index.html"
