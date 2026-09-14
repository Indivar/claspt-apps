// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Relative-time formatting for the generated-password list.
 *
 * This module used to hold the generated-password history itself, kept in
 * `chrome.storage.session` and written only when the user copied or used a
 * value. Both halves of that were wrong: session storage is wiped when the
 * browser closes AND when the vault locks, and a password that was generated
 * but not yet taken up was never written at all — so a password generated,
 * pasted into a site and then locked away was simply gone.
 *
 * The history now lives in the vault, encrypted and durable. See
 * `shared/generated-history.ts` for the layout, `shared/record-generated.ts`
 * for the client side, and `background/generated-history-store.ts` for the
 * vault work.
 */

export function formatTimeAgo(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return "";
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(timestamp).toLocaleDateString();
}
