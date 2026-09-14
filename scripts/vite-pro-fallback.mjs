// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Resolves the commercial frontend modules to their stand-ins when the real
 * file is absent, so the public tree builds from the same imports. The list
 * is the frontend part of `.publicignore` that other code imports; a module
 * nobody imports needs no stand-in.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Module path (under src/, no extension) -> stand-in (under src/pro-stubs/). */
export const PRO_MODULES = {
  "stores/sync-store": "stores/sync-store.ts",
  "stores/share-store": "stores/share-store.ts",
  "components/SyncStatusBar": "components/SyncStatusBar.tsx",
  "components/RestoreFromAccount": "components/RestoreFromAccount.tsx",
  "components/ConflictModal": "components/ConflictModal.tsx",
  "components/ShareBadge": "components/ShareBadge.tsx",
  "components/ShareModal": "components/ShareModal.tsx",
  "components/settings/LicensesTab": "components/settings/LicensesTab.tsx",
  "components/settings/IncomingShares": "components/settings/IncomingShares.tsx",
};

const EXTENSIONS = [".ts", ".tsx"];

/** The src-relative module path an import specifier names, or null. */
export function moduleKey(specifier, importer) {
  const srcDir = resolve(root, "src") + "/";
  let abs;
  if (specifier.startsWith("@/")) {
    abs = resolve(root, "src", specifier.slice(2));
  } else if (specifier.startsWith(".") && importer) {
    abs = resolve(dirname(importer), specifier);
  } else if (specifier.startsWith(srcDir)) {
    // Vite's alias plugin runs first and has already turned `@/x` into an
    // absolute path by the time this hook sees it.
    abs = specifier;
  } else {
    return null;
  }
  if (!abs.startsWith(srcDir)) return null;
  const key = abs.slice(srcDir.length).replace(/\.(tsx?|jsx?)$/, "");
  return key in PRO_MODULES ? key : null;
}

/** Where `key` resolves: the real file when present, else the stand-in. */
export function resolveProModule(key) {
  for (const ext of EXTENSIONS) {
    const real = resolve(root, "src", key + ext);
    if (existsSync(real)) return real;
  }
  return resolve(root, "src", "pro-stubs", PRO_MODULES[key]);
}

export function proFallback() {
  return {
    name: "claspt-pro-fallback",
    enforce: "pre",
    resolveId(specifier, importer) {
      const key = moduleKey(specifier, importer);
      return key ? resolveProModule(key) : null;
    },
  };
}
