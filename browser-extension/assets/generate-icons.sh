#!/bin/bash
# Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
# Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

# Generate placeholder SVG icons for the extension
# Replace these with actual Claspt icons before publishing
for size in 16 32 48 128; do
  cat > "assets/icon-${size}.svg" << EOF
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${size/8}" fill="#a78bfa"/>
  <text x="50%" y="55%" text-anchor="middle" dominant-baseline="middle"
        fill="#0f0f14" font-family="sans-serif" font-weight="bold"
        font-size="${size/2.5}">C</text>
</svg>
EOF
done
echo "SVG icons generated. Convert to PNG for the extension manifest."
