// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { execSync } from "child_process";
import { readFileSync } from "fs";
import { proFallback } from "./scripts/vite-pro-fallback.mjs";

const host = process.env.TAURI_DEV_HOST;

// Read version from package.json (single source of truth)
const { version } = JSON.parse(readFileSync("package.json", "utf-8"));

// Git build info — injected at compile time
function getGitInfo() {
  try {
    const hash = execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
    const date = execSync("git log -1 --format=%cd --date=short", {
      encoding: "utf-8",
    }).trim();
    const dirty = execSync("git status --porcelain", { encoding: "utf-8" }).trim();
    return { hash, date, dirty: dirty.length > 0 };
  } catch {
    return { hash: "unknown", date: "unknown", dirty: false };
  }
}

const git = getGitInfo();

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [proFallback(), react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __GIT_HASH__: JSON.stringify(git.hash),
    __GIT_DATE__: JSON.stringify(git.date),
    __GIT_DIRTY__: JSON.stringify(git.dirty),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    // "pro" (commercial trunk) or "oss" (the public, source-available build).
    // The public repo builds with CLASPT_EDITION=oss; the About dialog then
    // shows the PolyForm Shield terms and no licence panel.
    __CLASPT_EDITION__: JSON.stringify(process.env.CLASPT_EDITION || "pro"),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@claspt/shared": path.resolve(__dirname, "./shared/src"),
    },
  },
  // Vite options tailored for Tauri development
  clearScreen: false,
  optimizeDeps: {
    exclude: ["target"],
    entries: ["src/**/*.{ts,tsx}"],
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          mermaid: ["mermaid"],
          katex: ["katex", "marked-katex-extension"],
          "vis-timeline": ["vis-timeline", "vis-data"],
          chartjs: ["chart.js"],
          vizjs: ["@viz-js/viz"],
          abcjs: ["abcjs"],
          codemirror: [
            "@codemirror/autocomplete",
            "@codemirror/commands",
            "@codemirror/lang-markdown",
            "@codemirror/language",
            "@codemirror/language-data",
            "@codemirror/search",
            "@codemirror/state",
            "@codemirror/view",
            "codemirror",
          ],
        },
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : { overlay: false },
    watch: {
      // tell vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**", "**/target/**"],
    },
    // Pre-transform critical modules so the Tauri webview doesn't hit
    // an on-demand dep optimization restart on first load.
    warmup: {
      clientFiles: [
        "src/main.tsx",
        "src/App.tsx",
        "src/components/UnlockScreen.tsx",
        "src/stores/vault-store.ts",
        "src/stores/ui-store.ts",
        "src/lib/logger.ts",
        "src/lib/version.ts",
      ],
    },
  },
}));
