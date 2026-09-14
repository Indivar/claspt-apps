// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { describe, it, expect } from "vitest";
import { needsReview } from "@/lib/memory-review";

// Same four cases as `a_client_write_is_unreviewed_until_the_owner_says_otherwise`
// in src-tauri/src/pages/agent_memory.rs. Change both or neither.
describe("needsReview", () => {
  it("is true right after a client write", () => {
    expect(needsReview({ reviewed: false, written_by_name: "Claude Code" })).toBe(true);
  });

  it("is false once the owner marked the page reviewed", () => {
    expect(needsReview({ reviewed: true, written_by_name: "Claude Code" })).toBe(false);
  });

  it("is false for a page with no writer stamp", () => {
    expect(needsReview({})).toBe(false);
    expect(needsReview({ written_by_name: "" })).toBe(false);
  });

  it("is true for a stamped page from before the flag existed", () => {
    expect(needsReview({ written_by_name: "old client" })).toBe(true);
  });
});
