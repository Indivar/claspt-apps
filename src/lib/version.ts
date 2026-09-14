// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * version.ts — build/version identifiers surfaced to the UI (About dialog, logs).
 *
 * All values are baked in at build time via Vite `define` (see vite.config.ts).
 * `package.json` is the single source of truth for the semver; the git fields are
 * captured from the working tree at compile time. Nothing here is read at runtime.
 */

/* Injected by Vite at build time — see vite.config.ts */
declare const __APP_VERSION__: string;
declare const __GIT_HASH__: string;
declare const __GIT_DATE__: string;
declare const __GIT_DIRTY__: boolean;
declare const __BUILD_TIME__: string;
declare const __CLASPT_EDITION__: string;

/** Semver release version — sourced from package.json via Vite define. */
export const APP_VERSION: string = __APP_VERSION__;

/** Short git commit hash. */
export const GIT_HASH: string = __GIT_HASH__;

/** Date of the latest commit (YYYY-MM-DD). */
export const GIT_DATE: string = __GIT_DATE__;

/** Whether the working tree had uncommitted changes at build time. */
export const GIT_DIRTY: boolean = __GIT_DIRTY__;

/** ISO timestamp of when this build was compiled. */
export const BUILD_TIME: string = __BUILD_TIME__;

/**
 * Build edition: `"pro"` for the commercial build (this trunk) or `"oss"` for
 * the public, source-available build. Set via the `CLASPT_EDITION` env at build
 * time; the public repo builds with `"oss"`. The `typeof` guard keeps the module
 * from crashing during a Vite dev-server config reload before the define is present.
 */
export const EDITION: string =
  typeof __CLASPT_EDITION__ !== "undefined" ? __CLASPT_EDITION__ : "pro";

/** True for the commercial build (sync, sharing and the licence system on top of the public core). */
export const IS_PRO: boolean = EDITION !== "oss";

/** Full display string: "0.3.0 (abcdef0 · 2026-02-22)" */
export const VERSION_DISPLAY = `${APP_VERSION} (${GIT_HASH}${GIT_DIRTY ? "*" : ""} · ${GIT_DATE})`;
