// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * The span a transaction inserted, in the coordinates of the document after
 * it. A paste is one transaction; the editor checks what it brought in before
 * the first autosave can write it to disk.
 */

export interface InsertedRange {
  from: number;
  to: number;
}

interface ChangeSetLike {
  iterChanges(f: (fromA: number, toA: number, fromB: number, toB: number) => void): void;
}

/** The union of the inserted spans, or null when the change inserted nothing. */
export function insertedRange(changes: ChangeSetLike): InsertedRange | null {
  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  changes.iterChanges((_fromA, _toA, fromB, toB) => {
    if (toB <= fromB) return;
    from = Math.min(from, fromB);
    to = Math.max(to, toB);
  });
  return to > from ? { from, to } : null;
}
