// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { describe, expect, it } from "vitest";
import { insertedRange } from "@/lib/paste-range";

type Span = [number, number, number, number];
const changes = (spans: Span[]) => ({
  iterChanges: (f: (a: number, b: number, c: number, d: number) => void) =>
    spans.forEach((s) => f(...s)),
});

describe("insertedRange", () => {
  it("returns the inserted span, merged across pieces", () => {
    expect(insertedRange(changes([[3, 3, 3, 10]]))).toEqual({ from: 3, to: 10 });
    expect(
      insertedRange(
        changes([
          [3, 3, 3, 10],
          [20, 25, 27, 30],
        ]),
      ),
    ).toEqual({ from: 3, to: 30 });
  });

  it("ignores a transaction without text", () => {
    // A deletion, and an empty change set: nothing came in.
    expect(insertedRange(changes([[3, 8, 3, 3]]))).toBeNull();
    expect(insertedRange(changes([]))).toBeNull();
  });
});
