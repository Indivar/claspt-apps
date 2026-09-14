// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * The Firefox manifest is derived from the Chrome one, never hand-kept:
 * every key the two browsers share stays identical by construction, and the
 * three places they differ are listed here.
 *
 *   node scripts/firefox-manifest.mjs --write   # rewrites dist/manifest.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/** The Firefox version the build is tested against: MV3 background scripts,
 *  optional host permissions, storage.session access levels and document_start
 *  page-world injection all behave from here on. */
export const FIREFOX_MIN_VERSION = "128.0";

/**
 * @param {Record<string, unknown>} chrome The Chrome manifest, parsed.
 * @returns {Record<string, unknown>} The same manifest as Firefox loads it.
 */
export function toFirefoxManifest(chrome) {
  const out = structuredClone(chrome);
  const background = /** @type {{ service_worker?: string; type?: string }} */ (
    out.background ?? {}
  );
  if (background.service_worker) {
    // Firefox runs MV3 backgrounds as event pages, not service workers.
    out.background = {
      scripts: [background.service_worker],
      type: background.type ?? "module",
    };
  }
  const settings = /** @type {{ gecko?: Record<string, unknown> }} */ (
    out.browser_specific_settings ?? {}
  );
  out.browser_specific_settings = {
    ...settings,
    gecko: {
      ...(settings.gecko ?? {}),
      strict_min_version: FIREFOX_MIN_VERSION,
      // AMO requires every listing to say what it collects. Nothing: the
      // extension talks to the desktop app on this machine and nowhere else.
      data_collection_permissions: { required: ["none"] },
    },
  };
  return out;
}

const here = dirname(fileURLToPath(import.meta.url));
if (process.argv.includes("--write")) {
  const source = JSON.parse(readFileSync(resolve(here, "../manifest.json"), "utf8"));
  const target = resolve(here, "../dist/manifest.json");
  writeFileSync(target, JSON.stringify(toFirefoxManifest(source), null, 2) + "\n");
  console.log(`wrote Firefox manifest to ${target}`);
}
