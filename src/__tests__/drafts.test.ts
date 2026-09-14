// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { describe, it, expect, beforeEach } from "vitest";
import { DRAFT_PREFIX, draftKeyFor, canPersistDraft, clearAllDrafts } from "@/lib/drafts";

describe("drafts", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("namespaces a draft under the shared prefix", () => {
    expect(draftKeyFor("page-1")).toBe(`${DRAFT_PREFIX}page-1`);
  });

  it("refuses to draft a full-body-encrypted page", () => {
    // The redaction pass only removes `:::secret` fences, so for these pages it
    // removes nothing at all and the entire decrypted body would be stored.
    expect(canPersistDraft({ meta: { encrypted: true } })).toBe(false);
    expect(canPersistDraft({ meta: { encrypted: false } })).toBe(true);
  });

  it("removes every draft on lock and leaves other storage alone", () => {
    localStorage.setItem(draftKeyFor("page-1"), "unsaved body");
    localStorage.setItem(draftKeyFor("page-2"), "another body");
    localStorage.setItem("theme", "dark");

    clearAllDrafts();

    expect(localStorage.getItem(draftKeyFor("page-1"))).toBeNull();
    expect(localStorage.getItem(draftKeyFor("page-2"))).toBeNull();
    expect(localStorage.getItem("theme")).toBe("dark");
  });

  it("clears every draft even as removal shifts the key indices", () => {
    // Collecting keys before removing them matters: localStorage.key(i) is
    // positional, so deleting while iterating skips entries and would leave
    // drafts behind after a lock.
    for (let i = 0; i < 25; i += 1) {
      localStorage.setItem(draftKeyFor(`page-${i}`), `body ${i}`);
    }

    clearAllDrafts();

    const leftover = Object.keys(localStorage).filter((k) => k.startsWith(DRAFT_PREFIX));
    expect(leftover).toEqual([]);
  });

  it("does not throw when storage is unavailable", () => {
    const original = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("storage blocked");
      },
    });

    expect(() => clearAllDrafts()).not.toThrow();

    if (original) Object.defineProperty(window, "localStorage", original);
  });
});
