#!/bin/bash
# Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
# Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

set -euo pipefail

# ─── Microsoft Store Build Script ─────────────────
#
# Builds Claspt for Microsoft Store submission.
# Produces an .msix package without the auto-updater.
#
# Usage:
#   ./scripts/build-msstore.sh
#
# Prerequisites:
#   - Windows build environment (or cross-compilation setup)
#   - Tauri CLI installed
#
# This script:
#   1. Swaps capabilities to exclude updater permissions
#   2. Builds with --no-default-features --features store (excludes updater plugin)
#   3. Applies msstore config overlay (empty updater endpoints)
#   4. Restores original capabilities after build

APP_NAME="Claspt"
VERSION=$(node -p "require('./package.json').version")

echo "=== Building ${APP_NAME} v${VERSION} for Microsoft Store ==="

# Ensure version is synced
npm run version:sync

# ── Step 1: Swap capabilities for store build ──
echo "Swapping capabilities for store build..."
CAPS_DIR="src-tauri/capabilities"
cp "$CAPS_DIR/default.json" "$CAPS_DIR/default.json.bak"
cp "src-tauri/capabilities-store.json" "$CAPS_DIR/default.json"

# Restore on exit (even on failure)
restore_caps() {
    echo "Restoring original capabilities..."
    mv "$CAPS_DIR/default.json.bak" "$CAPS_DIR/default.json"
}
trap restore_caps EXIT

# ── Step 2: Build with store features (no updater) ──
echo "Building with store features (updater disabled)..."
cargo tauri build \
    --config src-tauri/tauri.msstore.conf.json \
    --no-default-features \
    --features store \
    -- --no-default-features --features store

echo ""
echo "=== Microsoft Store build complete ==="
echo ""
echo "The .msi / .exe installer is in target/release/bundle/"
echo ""
echo "Next steps:"
echo "  1. Package as .msix using MSIX Packaging Tool (if needed)"
echo "  2. Upload to Partner Center (https://partner.microsoft.com/)"
echo "  3. Use Windows-only screenshots in the listing"
echo "  4. Ensure all listing images show Windows UI only"
echo ""
