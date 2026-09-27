// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { describe, expect, it } from "vitest";
import { historyNoticeFor, scrubValues } from "@/lib/history-notice";

describe("historyNoticeFor", () => {
  it("says nothing when the history is clean or fully rewritten", () => {
    expect(historyNoticeFor({ kind: "clean" })).toBeNull();
    expect(
      historyNoticeFor({ kind: "rewrote", commits: 3, remaining_objects: 0 }),
    ).toBeNull();
  });

  it("tells the person what is left and what to do", () => {
    expect(historyNoticeFor({ kind: "rewrote", commits: 1, remaining_objects: 2 })).toBe(
      "The converted value was removed from 1 recent version. Some packed data from before remains until version history is reset in Settings.",
    );
    expect(
      historyNoticeFor({
        kind: "left_in_history",
        reason: "the value is in a version older than a day",
      }),
    ).toBe(
      "Earlier versions of this page still hold a value that is now a secret: the value is in a version older than a day. Reset version history in Settings to remove them.",
    );
  });
});

describe("scrubValues", () => {
  it("keeps only values long enough to be worth scrubbing", () => {
    expect(scrubValues(["5432", "hunter2hunter2", "admin"])).toEqual(["hunter2hunter2"]);
  });
});
