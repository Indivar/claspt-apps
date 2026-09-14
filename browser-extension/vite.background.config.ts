// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { defineConfig } from "vite";
import { resolve } from "path";

/** Build the background service worker as a single self-contained file. */
export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      "@claspt/shared": resolve(__dirname, "../shared/src"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: false, // Don't clear — popup/options already built
    lib: {
      entry: resolve(__dirname, "src/background/index.ts"),
      formats: ["es"],
      fileName: () => "src/background/index.js",
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
