// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { defineConfig } from "vitest/config";
import path from "path";
import { proFallback } from "./scripts/vite-pro-fallback.mjs";

export default defineConfig({
  plugins: [proFallback()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@claspt/shared": path.resolve(__dirname, "./shared/src"),
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify("0.0.0-test"),
    __GIT_HASH__: JSON.stringify("abc1234"),
    __GIT_DATE__: JSON.stringify("2026-01-01"),
    __GIT_DIRTY__: JSON.stringify(false),
    __BUILD_TIME__: JSON.stringify("2026-01-01T00:00:00.000Z"),
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/__tests__/setup.ts"],
    // Scoped to the desktop app's own tests. Without this the default glob also
    // picks up browser-extension/ and mobile/, which have their own runners,
    // aliases and environments, and fail to resolve here.
    include: ["src/__tests__/**/*.test.{ts,tsx}"],
  },
});
