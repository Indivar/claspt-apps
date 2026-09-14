// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { stores } from "./setup";

const KEY = "claspt_cred_state";

/**
 * cred-state keeps a module-level cache that is normally invalidated by
 * `chrome.storage.onChanged`. The stub does not fire that, so each test gets a
 * fresh module rather than inheriting the previous test's cache.
 */
async function freshModule() {
  vi.resetModules();
  return import("@/shared/cred-state");
}

beforeEach(() => {
  stores.local.clear();
});

describe("clearLastUsed", () => {
  it("drops the usage timestamps and keeps the pins", async () => {
    stores.local.set(KEY, {
      pinned: { "credentials/a.md::Bank": true },
      lastUsed: { "credentials/a.md::Bank": 1_700_000_000_000 },
    });

    const { clearLastUsed } = await freshModule();
    await clearLastUsed();

    const stored = stores.local.get(KEY) as { pinned: object; lastUsed: object };
    expect(stored.lastUsed).toEqual({});
    expect(stored.pinned).toEqual({ "credentials/a.md::Bank": true });
  });
});

describe("cred state basics", () => {
  it("builds a key from page path and label", async () => {
    const { credKey } = await freshModule();
    expect(credKey("credentials/a.md", "Bank")).toBe("credentials/a.md::Bank");
  });

  it("toggles a pin on and off", async () => {
    const { credKey, togglePin, isPinned } = await freshModule();
    const key = credKey("credentials/a.md", "Bank");

    let state = await togglePin(key);
    expect(isPinned(state, "credentials/a.md", "Bank")).toBe(true);

    state = await togglePin(key);
    expect(isPinned(state, "credentials/a.md", "Bank")).toBe(false);
  });

  it("records a last-used timestamp", async () => {
    const { credKey, markUsed, loadCredState } = await freshModule();
    await markUsed(credKey("credentials/b.md", "Mail"));
    const state = await loadCredState();
    expect(state.lastUsed["credentials/b.md::Mail"]).toBeGreaterThan(0);
  });

  it("honours the legacy page-level pin wildcard", async () => {
    stores.local.set(KEY, { pinned: { "credentials/a.md::*": true }, lastUsed: {} });
    const { loadCredState, isPinned } = await freshModule();
    const state = await loadCredState();
    expect(isPinned(state, "credentials/a.md", "Any Label")).toBe(true);
  });
});
