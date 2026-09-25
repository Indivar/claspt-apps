// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";
import { copyFileSync, mkdirSync, existsSync } from "fs";
import { noHtmlInjection } from "./scripts/no-html-injection.mjs";

/**
 * Vite config for Claspt browser extension.
 *
 * MV3 service workers cannot use ES module dynamic imports across chunks,
 * so we build each entry point separately and copy static assets.
 * This config builds the popup and options HTML entries; background and
 * content scripts are built via separate npm scripts.
 */
export default defineConfig({
  base: "./",
  plugins: [
    noHtmlInjection(),
    react(),
    tailwindcss(),
    {
      name: "copy-extension-assets",
      closeBundle() {
        // Copy manifest.json and icons to dist
        const dist = resolve(__dirname, "dist");
        copyFileSync(resolve(__dirname, "manifest.json"), resolve(dist, "manifest.json"));
        const assetsDir = resolve(dist, "assets");
        if (!existsSync(assetsDir)) mkdirSync(assetsDir, { recursive: true });
        for (const size of [16, 32, 48, 128]) {
          const src = resolve(__dirname, `assets/icon-${size}.png`);
          if (existsSync(src)) {
            copyFileSync(src, resolve(assetsDir, `icon-${size}.png`));
          }
        }
        // Copy logo
        const logoSrc = resolve(__dirname, "assets/logo-claspt.png");
        if (existsSync(logoSrc)) {
          copyFileSync(logoSrc, resolve(assetsDir, "logo-claspt.png"));
        }
        // Copy fonts
        const fontsDir = resolve(dist, "assets/fonts");
        if (!existsSync(fontsDir)) mkdirSync(fontsDir, { recursive: true });
        for (const font of ["figtree-variable.woff2", "jetbrains-mono-regular.woff2"]) {
          const src = resolve(__dirname, `assets/fonts/${font}`);
          if (existsSync(src)) {
            copyFileSync(src, resolve(fontsDir, font));
          }
        }
      },
    },
  ],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      "@claspt/shared": resolve(__dirname, "../shared/src"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, "src/popup/index.html"),
        options: resolve(__dirname, "src/options/index.html"),
      },
      output: {
        // Inline all chunks — extension pages load from local files
        manualChunks: undefined,
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
    target: "esnext",
    minify: false,
    sourcemap: true,
  },
  publicDir: "public",
});
