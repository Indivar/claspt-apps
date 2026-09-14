// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { defineConfig } from "vite";
import { resolve } from "path";

/** Build one passkey script as a single self-contained IIFE. */
export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      "@claspt/shared": resolve(__dirname, "../shared/src"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: false,
    lib: {
      entry: resolve(__dirname, "src/page/passkey-provider.ts"),
      formats: ["iife"],
      name: "ClasptPasskeyProvider",
      fileName: () => "src/page/passkey-provider.js",
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
    target: "esnext",
    minify: false,
    sourcemap: true,
  },
});
