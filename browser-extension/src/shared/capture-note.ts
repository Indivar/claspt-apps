// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import type { LastCapture } from "./types";

/** Older than this and the note is stale rather than helpful. */
export const NOTE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** One line on what became of the last sign-in on a site, when it says something. */
export function captureNoteText(capture: LastCapture): string | null {
  const who = capture.username || "The login";
  switch (capture.outcome) {
    case "captured":
      return `${who} was captured on the last sign-in and is waiting to be saved.`;
    case "parked":
      return `${who} was captured on the last sign-in and will be saved when Claspt is back.`;
    case "already_saved":
      return "The last sign-in used a login already saved here. Nothing to add.";
    case "never_save":
      return "Logins on this site are never saved. Change this under Settings.";
    case "excluded":
      return "This site is excluded in Settings, so logins here are not captured.";
    case "failed":
      return "The last sign-in here could not be saved.";
    default:
      return null;
  }
}
