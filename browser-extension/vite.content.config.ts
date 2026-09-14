// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { defineConfig } from "vite";
import { resolve } from "path";
import { copyFileSync, mkdirSync, existsSync } from "fs";

/** Build the content script as a single self-contained IIFE. */
export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      "@claspt/shared": resolve(__dirname, "../shared/src"),
    },
  },
  plugins: [
    {
      name: "copy-content-styles",
      closeBundle() {
        const destDir = resolve(__dirname, "dist/src/content");
        if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
        copyFileSync(
          resolve(__dirname, "src/content/styles.css"),
          resolve(destDir, "styles.css")
        );
      },
    },
  ],
  build: {
    outDir: "dist",
    emptyOutDir: false,
    lib: {
      entry: resolve(__dirname, "src/content/index.ts"),
      formats: ["iife"],
      name: "ClasptContent",
      fileName: () => "src/content/index.js",
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
