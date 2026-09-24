// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import React, { useState, useMemo } from "react";
import { detectPlatform, connectionHintsFor } from "@/shared/platform";

interface Props {
  defaultOpen?: boolean;
  /** Override the small heading. Defaults to "What you might see". */
  heading?: string;
}

/**
 * Compact disclosure that lists the OS-specific prompts a user is likely
 * to encounter on first connection, plus generic recovery steps. Used in
 * onboarding ("Allow local connection") and the disconnected empty state.
 */
export function TroubleshootingPanel({ defaultOpen = false, heading = "What you might see" }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const platform = useMemo(() => detectPlatform(), []);
  const hints = useMemo(() => connectionHintsFor(platform), [platform]);

  const platformLabel =
    platform === "mac" ? "macOS" :
    platform === "windows" ? "Windows" :
    platform === "linux" ? "Linux" : "your OS";

  return (
    <div className="mt-3 w-full text-left">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 rounded-md border border-border bg-surface-raised px-2.5 py-1.5 text-[11px] font-medium text-text-muted hover:text-text-primary transition-colors"
      >
        <span>
          {heading} <span className="text-text-dim">on {platformLabel}</span>
        </span>
        <svg
          width="10" height="10" viewBox="0 0 16 16" fill="currentColor"
          className={`transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path d="M4 6l4 4 4-4z" />
        </svg>
      </button>
      {open && (
        <div className="mt-1.5 space-y-2 rounded-md border border-border bg-surface px-3 py-2.5">
          {hints.map((hint) => (
            <div key={hint.title}>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-text-muted mb-0.5">
                {hint.title}
              </div>
              <ul className="space-y-0.5 text-[11px] text-text-secondary leading-relaxed">
                {hint.steps.map((step, i) => (
                  <li key={i} className="flex gap-1.5">
                    <span className="text-accent shrink-0">•</span>
                    <span>{step}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <div className="pt-1 text-[10px] text-text-dim border-t border-border/60">
            Still stuck? See <a
              href="https://docs.claspt.app/reference/connection-troubleshooting"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:underline"
            >the full troubleshooting guide</a>.
          </div>
        </div>
      )}
    </div>
  );
}
