// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Extract a human-readable message from any thrown value.
 *
 * Handles Tauri IPC errors (serialized Rust enums like `{"Import": "msg"}`),
 * standard Error instances, plain strings, and unknown shapes.
 */
export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object") {
    // Tauri serialized enum variant: {"Import": "Parse error: ..."}
    const values = Object.values(e as Record<string, unknown>);
    if (values.length > 0 && typeof values[0] === "string") return values[0];
    // Object with message property
    if ("message" in e && typeof (e as Record<string, unknown>).message === "string")
      return (e as Record<string, unknown>).message as string;
  }
  return String(e);
}
