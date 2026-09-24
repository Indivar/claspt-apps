// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Which secret fields get an inline Generate button. The rule is the shared
 * one, so the desktop picker and the extension's Add new form offer it on
 * the same fields. Kept out of the component module so the component file
 * only exports components (enabling React Fast Refresh).
 */
import { wantsGenerator } from "@claspt/shared/secret-templates";

/** Check if a field key should have a generate button. */
export function isGeneratable(key: string): boolean {
  return wantsGenerator(key);
}
