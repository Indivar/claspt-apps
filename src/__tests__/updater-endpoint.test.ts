// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * The updater endpoint lives on the API host, not the marketing site. It
 * pointed at the marketing site from the day the updater shipped, which
 * answered every check with an HTML 404, so no installed copy has ever been
 * offered an update. This pins the host so the mistake cannot come back.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const conf = JSON.parse(
  readFileSync(resolve(__dirname, "../../src-tauri/tauri.conf.json"), "utf8"),
) as { plugins: { updater: { endpoints: string[]; pubkey: string } } };

describe("updater configuration", () => {
  it("asks the API host, where the route exists", () => {
    const endpoints = conf.plugins.updater.endpoints;
    expect(endpoints).toHaveLength(1);
    const url = new URL(endpoints[0]!.replace(/\{\{[^}]+\}\}/g, "x"));
    expect(url.protocol).toBe("https:");
    expect(url.host).toBe("app.claspt.app");
    expect(url.pathname).toBe("/api/v1/updates/x/x");
  });

  it("carries a signing public key, so a manifest cannot be forged", () => {
    expect(conf.plugins.updater.pubkey.length).toBeGreaterThan(40);
  });
});
