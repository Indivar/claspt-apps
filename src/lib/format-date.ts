// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * format-date.ts — locale-aware date formatting for the UI.
 *
 * Renders ISO timestamps (page `created_at`/`updated_at`, commit dates) using the
 * user's locale. For relative "time ago" formatting see `shared/format-time`.
 */

/** Format an ISO date string as a readable short date with time. */
export function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
