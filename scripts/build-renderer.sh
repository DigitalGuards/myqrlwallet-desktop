#!/usr/bin/env bash
#
# build-renderer.sh
#
# Builds the REAL ../myqrlwallet-frontend React app as the desktop renderer and
# stages it at out/renderer/, served by the main process at app://wallet/index.html.
#
# Release builds set QRL_FRONTEND_DIR to a detached checkout of the revision
# documented in docs/FRONTEND_INTEGRATION.md. CI checks out that pinned revision.
# Development builds can use the current sibling frontend checkout (submodule).
# The frontend source stays in its own repository.
#
# The frontend needs exactly two desktop adaptations, both already in the
# frontend repo and BOTH web-safe:
#   1. Vite `base: './'` under app://wallet - driven here by VITE_DESKTOP=1
#      (config/vite.config.ts reads it; web builds keep '/').
#   2. createBrowserRouter -> createHashRouter under app://wallet - handled at
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
# The network comes from the build-time QRL_NETWORK_PROFILE: testnet (the
# default) or mainnet. Its pins, RPC path and QNS default are read from the
# network table in src/main/config.ts, the same row the main process pins, so
# the renderer and the broker always ship one network. A profile without both
# identity pins (mainnet before launch) stops this script before it installs
# or builds anything.
#
# `--print-env` prints the renderer build environment and the desktop CSP, then
# exits without touching the frontend (test/rendererEnv.test.ts compares it).
#
# Fails with guidance if the frontend source or lockfile is absent.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
FRONTEND_DIR="${QRL_FRONTEND_DIR:-$(cd "${DESKTOP_DIR}/.." && pwd)/myqrlwallet-frontend}"
OUT_RENDERER="${DESKTOP_DIR}/out/renderer"

PRINT_ENV=0
case "${1:-}" in
  '') ;;
  --print-env) PRINT_ENV=1 ;;
  *)
    echo "[build-renderer] ERROR: unknown argument ${1}" >&2
    exit 1
    ;;
esac

echo "[build-renderer] frontend dir: ${FRONTEND_DIR}"
echo "[build-renderer] out renderer: ${OUT_RENDERER}"

# The network row for QRL_NETWORK_PROFILE, from src/main/config.ts NETWORKS.
# scripts/network-values.mjs exits 1 for a profile that cannot run, and the
# assignment below then stops the script (set -e).
NETWORK_VALUES="$(cd "${DESKTOP_DIR}" && node --import tsx scripts/network-values.mjs)"
QRL_NET_NETWORK_PROFILE=''
QRL_NET_TESTNET_CHAIN_ID=''
QRL_NET_TESTNET_GENESIS_HASH=''
QRL_NET_TESTNET_RPC_PATH=''
QRL_NET_TESTNET_QNS_REGISTRY=''
QRL_NET_MAINNET_CHAIN_ID=''
QRL_NET_MAINNET_GENESIS_HASH=''
QRL_NET_MAINNET_RPC_PATH=''
QRL_NET_MAINNET_QNS_REGISTRY=''
while IFS='=' read -r key value; do
  case "${key}" in
    NETWORK_PROFILE | TESTNET_CHAIN_ID | TESTNET_GENESIS_HASH | TESTNET_RPC_PATH | \
      TESTNET_QNS_REGISTRY | MAINNET_CHAIN_ID | MAINNET_GENESIS_HASH | MAINNET_RPC_PATH | \
      MAINNET_QNS_REGISTRY)
      printf -v "QRL_NET_${key}" '%s' "${value}"
      ;;
    *)
      echo "[build-renderer] ERROR: unexpected network value '${key}'" >&2
      exit 1
      ;;
  esac
done <<<"${NETWORK_VALUES}"
if [[ -z "${QRL_NET_TESTNET_CHAIN_ID}" || -z "${QRL_NET_TESTNET_GENESIS_HASH}" ]]; then
  echo "[build-renderer] ERROR: the network table returned no testnet pins" >&2
  exit 1
fi
if [[ "${QRL_NET_NETWORK_PROFILE}" == "mainnet" && \
  (-z "${QRL_NET_MAINNET_CHAIN_ID}" || -z "${QRL_NET_MAINNET_GENESIS_HASH}") ]]; then
  echo "[build-renderer] ERROR: the network table returned no mainnet pins" >&2
  exit 1
fi
# Pins come from the network table alone, and a desktop renderer lists exactly
# the build's network.
if [[ -n "${VITE_MAINNET_CHAIN_ID:-}" || -n "${VITE_MAINNET_GENESIS_HASH:-}" ]]; then
  echo "[build-renderer] ERROR: set the mainnet pins in src/main/config.ts NETWORKS; VITE_MAINNET_CHAIN_ID and VITE_MAINNET_GENESIS_HASH must stay unset." >&2
  exit 1
fi
if [[ -n "${VITE_V3_NATIVE_NETWORK:-}" && "${VITE_V3_NATIVE_NETWORK}" != "${QRL_NET_NETWORK_PROFILE}" ]]; then
  echo "[build-renderer] ERROR: VITE_V3_NATIVE_NETWORK=${VITE_V3_NATIVE_NETWORK} differs from the ${QRL_NET_NETWORK_PROFILE} build profile (QRL_NETWORK_PROFILE)." >&2
  exit 1
fi
echo "[build-renderer] network profile: ${QRL_NET_NETWORK_PROFILE}"

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

# The renderer and native broker ship the same qualified v3 network identity,
# from the network table. The reused frontend's v3 profile always carries the
# testnet block; a mainnet build adds the mainnet block and lists only mainnet.
export VITE_WALLET_PROFILE=v3-private
export VITE_V3_CHAIN_ID="${QRL_NET_TESTNET_CHAIN_ID}"
export VITE_V3_GENESIS_HASH="${QRL_NET_TESTNET_GENESIS_HASH}"
# QNS registry on the v3 testnet, the same one qrlwallet.com uses: Send resolves
# names ending in .qrl. Leave it empty to build without name resolution.
export VITE_V3_QNS_REGISTRY="${VITE_V3_QNS_REGISTRY-${QRL_NET_TESTNET_QNS_REGISTRY}}"
if [[ "${VITE_NODE_ENV}" == "production" ]]; then
  RENDERER_RPC_BASE="${VITE_RPC_URL_PRODUCTION}"
  export VITE_V3_SERVER_URL="${VITE_SERVER_URL_PRODUCTION}"
  export VITE_V3_EXPLORER_URL="${VITE_EXPLORER_URL_PRODUCTION}"
else
  RENDERER_RPC_BASE="${VITE_RPC_URL_DEVELOPMENT}"
  export VITE_V3_SERVER_URL="${VITE_SERVER_URL_DEVELOPMENT}"
  export VITE_V3_EXPLORER_URL="${VITE_EXPLORER_URL_DEVELOPMENT}"
fi
export VITE_V3_RPC_URL="${RENDERER_RPC_BASE}/${QRL_NET_TESTNET_RPC_PATH}"
if [[ "${QRL_NET_NETWORK_PROFILE}" == "mainnet" ]]; then
  # The desktop renderer lists only the build's network.
  export VITE_V3_NATIVE_NETWORK=mainnet
  export VITE_MAINNET_CHAIN_ID="${QRL_NET_MAINNET_CHAIN_ID}"
  export VITE_MAINNET_GENESIS_HASH="${QRL_NET_MAINNET_GENESIS_HASH}"
  export VITE_MAINNET_RPC_URL="${RENDERER_RPC_BASE}/${QRL_NET_MAINNET_RPC_PATH}"
  export VITE_MAINNET_SERVER_URL="${VITE_V3_SERVER_URL}"
  # Empty by default: mainnet then has no explorer links, explorer discovery
  # or price. Export VITE_MAINNET_EXPLORER_URL once an explorer indexes it.
  export VITE_MAINNET_EXPLORER_URL="${VITE_MAINNET_EXPLORER_URL-}"
  # The mainnet QNS registry from the network table (empty: names off).
  export VITE_MAINNET_QNS_REGISTRY="${VITE_MAINNET_QNS_REGISTRY-${QRL_NET_MAINNET_QNS_REGISTRY}}"
fi

# The reused frontend ships a <meta http-equiv="Content-Security-Policy"> tuned
# for WEB hosting: script-src carries 'unsafe-inline' and connect-src allows
# http://localhost:* (both fine behind nginx's strict header, wrong for the
# desktop). The desktop's authoritative CSP is now delivered as a real response
# header by the app-protocol handler (src/main/appProtocol.ts), but the meta tag
# stays enforced too, so it is rewritten WHOLESALE to the desktop policy after
# the build: no inline script, no localhost connects, connect-src limited to the
# configured backend + relay + explorer. Mirror src/main/security.ts
# buildContentSecurityPolicy, minus frame-ancestors (ignored in meta CSP).
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
DESKTOP_CSP="default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://${SERVER_HOST} wss://${SERVER_HOST} https://qrlwallet.com wss://qrlwallet.com https://${EXPLORER_HOST}; img-src 'self' data: https://${SERVER_HOST}; media-src 'self' blob:; font-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'; worker-src 'self'"
if [[ -z "${SERVER_HOST}" || -z "${EXPLORER_HOST}" ]]; then
  echo "[build-renderer] ERROR: could not resolve the CSP server and explorer hosts" >&2
  exit 1
fi

if [[ "${PRINT_ENV}" == 1 ]]; then
  env | grep '^VITE_' | LC_ALL=C sort
  printf 'DESKTOP_CSP=%s\n' "${DESKTOP_CSP}"
  exit 0
fi

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

echo "[build-renderer] building frontend (VITE_DESKTOP=1, VITE_NODE_ENV=${VITE_NODE_ENV})..."
if [[ "${VITE_NODE_ENV}" == "production" ]]; then
  echo "[build-renderer]   server/RPC -> ${VITE_SERVER_URL_PRODUCTION}, explorer -> ${VITE_EXPLORER_URL_PRODUCTION}"
else
  echo "[build-renderer]   server/RPC -> ${VITE_SERVER_URL_DEVELOPMENT}, explorer -> ${VITE_EXPLORER_URL_DEVELOPMENT}"
fi
# VITE_DESKTOP=1 -> base './' for app://wallet. The router switches to hash routing
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
cp "${DESKTOP_DIR}/src/migration/index.html" "${OUT_RENDERER}/storage-migration.html"

RENDER_HTML="${OUT_RENDERER}/index.html"
if [[ ! -s "${RENDER_HTML}" ]]; then
  echo "[build-renderer] ERROR: staged renderer entrypoint missing or empty at ${RENDER_HTML}." >&2
  exit 1
fi

# Rewrite the staged renderer's meta CSP to DESKTOP_CSP (derived above).
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
const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${escapedCsp}">\n    <meta http-equiv="X-DNS-Prefetch-Control" content="off">`;
html = html.replace(/<meta\b(?=[^>]*\bhttp-equiv\s*=\s*(["'])X-DNS-Prefetch-Control\1)[^>]*>/gi, '');
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
