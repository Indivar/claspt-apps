// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Debug logger — silent by default, enabled via hidden toggle in Settings.
 *
 * To enable: triple-click the version number in the extension Settings tab.
 * Stored in chrome.storage.local as claspt_debug: true/false.
 *
 * Usage:
 *   import { dbg } from "@/shared/debug";
 *   dbg("message", data);  // only logs when debug mode is on
 */

const STORAGE_KEY = "claspt_debug";
let _enabled = false;

/** Load debug state from storage (call once at startup) */
export async function loadDebugState(): Promise<void> {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    _enabled = result[STORAGE_KEY] === true;
  } catch {
    _enabled = false;
  }
}

/** Check if debug mode is on (synchronous, must call loadDebugState first) */
export function isDebugEnabled(): boolean {
  return _enabled;
}

/** Toggle debug mode on/off */
export async function toggleDebug(): Promise<boolean> {
  _enabled = !_enabled;
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: _enabled });
  } catch {
    // Storage may not be available
  }
  return _enabled;
}

/** Debug log — only outputs when debug mode is enabled */
export function dbg(...args: unknown[]): void {
  if (!_enabled) return;
  console.log("[Claspt Debug]", ...args);
}

/** Debug warn — only outputs when debug mode is enabled */
export function dbgWarn(...args: unknown[]): void {
  if (!_enabled) return;
  console.warn("[Claspt Debug]", ...args);
}
