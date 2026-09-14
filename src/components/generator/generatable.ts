// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Helper for deciding which secret fields get an inline generate button.
 * Kept out of the component module so the component file only exports
 * components (enabling React Fast Refresh).
 */

/** Keys that should show inline generate buttons. */
const GENERATABLE_KEYS = new Set([
  "password",
  "passphrase",
  "pin",
  "cvv",
  "api key",
  "api secret",
  "secret",
  "key",
  "2fa backup",
]);

/** Check if a field key should have a generate button. */
export function isGeneratable(key: string): boolean {
  return GENERATABLE_KEYS.has(key.toLowerCase());
}
