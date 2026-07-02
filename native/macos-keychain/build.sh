#!/usr/bin/env bash
set -euo pipefail

# Compile the macOS Keychain helper to resources/qrl-keychain-helper.
#
# This is a macOS-only build step (swiftc + Security/LocalAuthentication
# frameworks). On any non-Darwin host we skip cleanly with exit 0 so the
# overall build does not fail on Linux/Windows CI or dev machines.
#
# For distribution the helper MUST be codesigned with the same Developer ID +
# hardened runtime as the app. We do NOT sign it here: electron-builder
# deep-signs every file copied in via the mac extraResources block (resources/
# -> Contents/Resources), so simply placing the compiled binary in resources/
# before packaging is sufficient. The Designated Requirement that binds the
# Keychain item to our signature comes from that app-level signature.

if [ "$(uname)" != "Darwin" ]; then
  echo "build.sh: not macOS (uname=$(uname)); skipping Keychain helper build."
  exit 0
fi

# Derive every path from this script's own location so the build works from
# any CWD on any host (never hardcode a machine-specific absolute path here).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
OUT="${REPO_DIR}/resources/qrl-keychain-helper"
SRC="${SCRIPT_DIR}/KeychainHelper.swift"

mkdir -p "$(dirname "$OUT")"

swiftc -O \
  -framework Security \
  -framework LocalAuthentication \
  -o "$OUT" \
  "$SRC"

echo "build.sh: compiled $OUT"
