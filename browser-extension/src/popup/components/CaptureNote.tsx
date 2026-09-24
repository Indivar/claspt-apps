// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import React, { useEffect, useState } from "react";
import type { LastCapture, Message } from "@/shared/types";
import { captureNoteText, NOTE_MAX_AGE_MS } from "@/shared/capture-note";

/** One quiet line on what became of the last sign-in on this site. */
export function CaptureNote({ domain }: { domain: string }) {
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    if (!domain) return;
    try {
      chrome.runtime.sendMessage(
        { type: "LAST_CAPTURE_GET", domain } as Message,
        (res: Message) => {
          if (chrome.runtime.lastError) return;
          if (res?.type !== "LAST_CAPTURE_RESULT") return;
          const capture: LastCapture | null = res.capture;
          if (!capture || Date.now() - capture.at > NOTE_MAX_AGE_MS) return;
          setText(captureNoteText(capture));
        },
      );
    } catch {
      // No worker to ask; the note is optional.
    }
  }, [domain]);

  if (!text) return null;

  return (
    <p className="px-3 py-1.5 text-[10px] leading-snug text-text-muted border-b border-border">
      {text}
    </p>
  );
}
