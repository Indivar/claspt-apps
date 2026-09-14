#!/bin/bash
# Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
# Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

set -euo pipefail

# ─── Mac App Store Build Script ────────────────────
#
# Builds Claspt for Mac App Store submission.
# Produces a signed .pkg ready for upload via Transporter.
#
# Prerequisites (one-time setup in Apple Developer portal):
#   1. Create "3rd Party Mac Developer Application" certificate
#   2. Create "3rd Party Mac Developer Installer" certificate
#   3. Create a Mac App Store provisioning profile for in.indivar.claspt
#   4. Download and install all three in Keychain Access
#
# Usage:
#   ./scripts/build-mas.sh
#
# Environment variables (optional overrides):
#   MAS_APP_IDENTITY   - signing identity for the app (default: auto-detect)
#   MAS_INSTALLER_IDENTITY - signing identity for the .pkg (default: auto-detect)

APP_NAME="Claspt"
BUNDLE_ID="in.indivar.claspt"
VERSION=$(node -p "require('./package.json').version")

echo "=== Building ${APP_NAME} v${VERSION} for Mac App Store ==="

# Ensure version is synced
npm run version:sync

# ── Step 1: Build the Tauri app (universal binary, no updater) ──
# Mac App Store forbids self-updaters — build with --features store which
# excludes the updater plugin at compile time.
# Capabilities file must also exclude `updater:default` (build fails otherwise).
echo "Building universal binary (store variant, no updater)..."

# Swap in the store capabilities (no updater permission) for the build.
# Restore on exit regardless of build outcome.
cp src-tauri/capabilities/default.json src-tauri/capabilities/default.json.bak
cp src-tauri/capabilities-store.json src-tauri/capabilities/default.json
trap 'mv src-tauri/capabilities/default.json.bak src-tauri/capabilities/default.json 2>/dev/null || true' EXIT

cargo tauri build --target universal-apple-darwin --no-bundle \
  --config src-tauri/tauri.mas.conf.json \
  -- --no-default-features --features store 2>&1 | tail -5

# Restore capabilities immediately after the build succeeds (trap still fires on exit)
mv src-tauri/capabilities/default.json.bak src-tauri/capabilities/default.json
trap - EXIT

# ── Step 2: Create the .app bundle manually ──
# (We skip Tauri's bundler because it signs with Developer ID, not MAS)
echo "Creating .app bundle..."

BUILD_DIR="target/universal-apple-darwin/release"
APP_DIR="${BUILD_DIR}/mas"
APP_PATH="${APP_DIR}/${APP_NAME}.app"
# The binary name in Cargo.toml is lowercase "claspt", so the actual built
# binary is at target/.../release/claspt (lowercase). Info.plist's
# CFBundleExecutable = "claspt", so the binary inside the bundle must match.
BINARY_NAME="claspt"
BINARY="${BUILD_DIR}/${BINARY_NAME}"

rm -rf "${APP_DIR}"
mkdir -p "${APP_PATH}/Contents/MacOS"
mkdir -p "${APP_PATH}/Contents/Resources"

# Copy binary — keep the lowercase name to match CFBundleExecutable
cp "${BINARY}" "${APP_PATH}/Contents/MacOS/${BINARY_NAME}"

# Copy existing .app resources from the regular build (icons, Info.plist, etc.)
REGULAR_APP="${BUILD_DIR}/bundle/macos/${APP_NAME}.app"
if [ -d "${REGULAR_APP}" ]; then
  cp -R "${REGULAR_APP}/Contents/Resources/"* "${APP_PATH}/Contents/Resources/" 2>/dev/null || true
  cp "${REGULAR_APP}/Contents/Info.plist" "${APP_PATH}/Contents/" 2>/dev/null || true
fi

# ── Step 3: Sign with Mac App Store identity ──
MAS_APP_IDENTITY="${MAS_APP_IDENTITY:-3rd Party Mac Developer Application: Varinder Singh}"
MAS_INSTALLER_IDENTITY="${MAS_INSTALLER_IDENTITY:-3rd Party Mac Developer Installer: Varinder Singh}"

echo "Signing with: ${MAS_APP_IDENTITY}"

# Strip any existing signatures from the built app (from regular build).
# Modifying a signed bundle invalidates the signature; start fresh.
codesign --remove-signature "${APP_PATH}" 2>/dev/null || true
find "${APP_PATH}/Contents" \( -name "*.dylib" -o -name "*.framework" -o -perm -u+x -type f \) \
  -exec codesign --remove-signature {} 2>/dev/null \; || true

# Sign inner libraries/frameworks first (with inherit entitlements).
find "${APP_PATH}/Contents" -name "*.dylib" -o -name "*.framework" | while read -r lib; do
  codesign --force --sign "${MAS_APP_IDENTITY}" \
    --entitlements src-tauri/entitlements/mas-inherit.entitlements \
    "${lib}" 2>/dev/null || true
done

# Sign the main executable with the full MAS sandbox entitlements.
codesign --force --sign "${MAS_APP_IDENTITY}" \
  --entitlements src-tauri/entitlements/mas.entitlements \
  "${APP_PATH}/Contents/MacOS/${BINARY_NAME}"

# Sign the .app bundle last — this wraps all the inner signatures.
# MAS requires sandbox entitlements on the outer bundle.
# DO NOT use --options runtime — Mac App Store is incompatible with Hardened Runtime
# (MAS uses its own sandbox; Hardened Runtime is for notarized direct-download apps).
codesign --force --sign "${MAS_APP_IDENTITY}" \
  --entitlements src-tauri/entitlements/mas.entitlements \
  "${APP_PATH}"

echo "Verifying signature..."
codesign --verify --deep --strict --verbose=2 "${APP_PATH}"

# ── Step 4: Create the .pkg installer ──
PKG_PATH="${APP_DIR}/${APP_NAME}_${VERSION}_mas.pkg"

echo "Creating .pkg..."
productbuild \
  --component "${APP_PATH}" /Applications \
  --sign "${MAS_INSTALLER_IDENTITY}" \
  "${PKG_PATH}"

echo ""
echo "=== Mac App Store build complete ==="
echo "  .app: ${APP_PATH}"
echo "  .pkg: ${PKG_PATH}"
echo ""
echo "Next steps:"
echo "  1. Open Transporter (from App Store on your Mac)"
echo "  2. Drag ${PKG_PATH} into Transporter"
echo "  3. Click Deliver"
echo "  4. Go to App Store Connect to complete the listing"
echo ""
