// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  FIREFOX_MIN_VERSION,
  toFirefoxManifest,
} from "../../scripts/firefox-manifest.mjs";

const chrome = JSON.parse(
  readFileSync(resolve(__dirname, "../../manifest.json"), "utf8"),
);

describe("toFirefoxManifest", () => {
  it("turns the service worker into a background script and pins the gecko settings", () => {
    const firefox = toFirefoxManifest(chrome) as typeof chrome;
    expect(firefox.background).toEqual({
      scripts: ["src/background/index.js"],
      type: "module",
    });
    expect(firefox.browser_specific_settings.gecko.id).toBe(
      chrome.browser_specific_settings.gecko.id,
    );
    expect(firefox.browser_specific_settings.gecko.strict_min_version).toBe(
      FIREFOX_MIN_VERSION,
    );
    expect(firefox.browser_specific_settings.gecko.data_collection_permissions).toEqual({
      required: ["none"],
    });
  });

  it("leaves everything the browsers share untouched, and the Chrome manifest itself", () => {
    const before = JSON.stringify(chrome);
    const firefox = toFirefoxManifest(chrome) as typeof chrome;
    expect(JSON.stringify(chrome)).toBe(before);
    for (const key of [
      "name",
      "version",
      "permissions",
      "optional_host_permissions",
      "content_scripts",
      "web_accessible_resources",
      "action",
      "commands",
      "icons",
    ]) {
      expect(firefox[key]).toEqual(chrome[key]);
    }
    expect(
      firefox.content_scripts.some(
        (c: { run_at?: string }) => c.run_at === "document_start",
      ),
    ).toBe(true);
  });
});
