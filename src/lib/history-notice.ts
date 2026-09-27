// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import type { ScrubOutcome } from "@/lib/commands";

/** Values worth scrubbing from history: long enough not to be an ordinary word. */
export const MIN_SCRUB_VALUE_LENGTH = 8;

export function scrubValues(values: string[]): string[] {
  return values.filter((v) => v.length >= MIN_SCRUB_VALUE_LENGTH);
}

/**
 * What the inspector says under Version History after a scrub, or null when
 * there is nothing the person needs to know.
 */
export function historyNoticeFor(outcome: ScrubOutcome): string | null {
  switch (outcome.kind) {
    case "clean":
      return null;
    case "rewrote":
      return outcome.remaining_objects > 0
        ? `The converted value was removed from ${outcome.commits} recent ${outcome.commits === 1 ? "version" : "versions"}. Some packed data from before remains until version history is reset in Settings.`
        : null;
    case "left_in_history":
      return `Earlier versions of this page still hold a value that is now a secret: ${outcome.reason}. Reset version history in Settings to remove them.`;
  }
}
