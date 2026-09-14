// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * clipboard.ts — native clipboard access for secret-safe copy/paste.
 *
 * All clipboard I/O goes through Tauri's native clipboard plugin rather than the
 * web `navigator.clipboard` API, which fails silently inside Tauri WebViews due to
 * WebKit permission gating. Copying a secret pairs {@link copyToClipboard} with
 * {@link clearClipboardAfter} so sensitive values (passwords, tokens) don't linger
 * on the system clipboard indefinitely.
 */
import { writeText, readText } from "@tauri-apps/plugin-clipboard-manager";

/**
 * Write text to the system clipboard using Tauri's native clipboard plugin.
 * This bypasses WebKit's clipboard permission restrictions that cause
 * navigator.clipboard.writeText() to fail silently in Tauri WebViews.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await writeText(text);
    return true;
  } catch (err) {
    console.error("[clipboard] write failed:", err);
    return false;
  }
}

/**
 * Clear the clipboard after a delay (for sensitive data like passwords).
 * Returns a timeout handle that can be cleared with clearTimeout().
 */
export function clearClipboardAfter(delayMs: number): ReturnType<typeof setTimeout> {
  return setTimeout(async () => {
    try {
      await writeText("");
    } catch {
      // Best-effort clear — don't surface errors for cleanup
    }
  }, delayMs);
}

/**
 * Read text from the system clipboard.
 */
export async function readFromClipboard(): Promise<string> {
  try {
    return await readText();
  } catch (err) {
    console.error("[clipboard] read failed:", err);
    return "";
  }
}
