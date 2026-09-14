// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import type { Message } from "./types";

/**
 * Build a PATCH_SECRET_BLOCK message that sets one field, or removes it when
 * the value is empty.
 *
 * Four call sites need exactly this (the popup's note editor, URL-match
 * selector and row menu, plus the inline picker's primary/deprecated toggles),
 * and they used to each hand-roll a PATCH_CREDENTIAL_FIELD message against a
 * separate, regex-based code path in the background worker. Sharing the shape
 * here keeps "empty means delete" defined in one place.
 */
export function buildFieldPatch(
  pagePath: string,
  label: string,
  key: string,
  value: string,
): Message {
  const clearing = value.length === 0;
  return {
    type: "PATCH_SECRET_BLOCK",
    pagePath,
    label,
    fields: clearing ? {} : { [key]: value },
    deleteFields: clearing ? [key] : [],
  };
}
