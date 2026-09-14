// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import type { PageMeta } from "@claspt/shared/types";

/**
 * Whether a memory page holds client-written content the owner has not
 * looked at. Mirrors `agent_memory::needs_review` in the Rust backend; the
 * test in `src/__tests__/memory-review.test.ts` carries the same truth table
 * so the two cannot drift apart unnoticed.
 */
export function needsReview(
  meta: Pick<PageMeta, "reviewed" | "written_by_name">,
): boolean {
  if (meta.reviewed !== undefined) {
    return !meta.reviewed;
  }
  return meta.written_by_name !== undefined && meta.written_by_name !== "";
}
