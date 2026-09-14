// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * platform.ts — OS detection helpers for platform-correct shortcut labels.
 *
 * Used purely for display (e.g. rendering "Cmd" vs "Ctrl" in tooltips and the
 * help modal); actual key handling checks `metaKey || ctrlKey` directly.
 */

/** Whether the user is on macOS (for keyboard shortcut labels). */
export const isMac =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform);

/** Platform modifier key label: "Cmd" on macOS, "Ctrl" elsewhere. */
export const modKey = isMac ? "Cmd" : "Ctrl";

/** Build a keyboard shortcut label, replacing "Mod" with the platform modifier. */
export function kbd(shortcut: string): string {
  return shortcut.replace(/Mod/g, modKey);
}
