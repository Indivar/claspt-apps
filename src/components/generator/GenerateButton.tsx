// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * GenerateButton — the shared "Regenerate + Copy" control used by each
 * generator tab. Copying places the value on the clipboard and schedules an
 * automatic clipboard clear so secrets don't linger there.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { copyToClipboard, clearClipboardAfter } from "@/lib/clipboard";
import { recordGeneratedValue, markGeneratedValueUsed } from "@/lib/generated-history";

/**
 * @param value The current generated value (empty string disables Copy).
 * @param onGenerate Invoked when the Regenerate button is pressed.
 * @param generating When true, disables the button and spins the icon.
 */
export function GenerateButton({
  value,
  onGenerate,
  generating,
}: {
  value: string;
  onGenerate: () => void;
  generating: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Keep every generated value in the vault, a moment after it stops changing.
   *
   * Every option control regenerates, so writing immediately would put one
   * entry in the vault per slider step. The pause means the value the user
   * settles on is the one kept — and it is kept whether or not they go on to
   * use it, because a password generated, regenerated past and then wanted back
   * is exactly what used to be lost.
   */
  useEffect(() => {
    if (!value) return;
    const timer = setTimeout(() => {
      void recordGeneratedValue(value).catch(() => {
        // The vault is the only durable place for these; if it refuses the
        // write there is nowhere safe to fall back to, and the value is still
        // on screen for the user to take.
      });
    }, 700);
    return () => clearTimeout(timer);
  }, [value]);

  const handleCopy = useCallback(async () => {
    if (!value) return;
    const ok = await copyToClipboard(value);
    if (ok) {
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = clearClipboardAfter(30_000);
      // Taking a password up is what distinguishes it from a discarded
      // candidate, and is what keeps the clear-unused sweep off it.
      void markGeneratedValueUsed(value).catch(() => {});
    }
  }, [value]);

  // Clear timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  // Reset "Copied" after 2s
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <div className="flex gap-2">
      <button
        onClick={onGenerate}
        disabled={generating}
        className="flex items-center gap-1.5 rounded-lg bg-accent px-4 py-1.5 text-[13px] font-medium text-white transition-all hover:bg-accent-hover active:scale-95 disabled:opacity-60"
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 16 16"
          fill="none"
          className={generating ? "animate-spin" : ""}
        >
          <path
            d="M14 8A6 6 0 112 8"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <path
            d="M14 4V8h-4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {generating ? "Generating..." : "Regenerate"}
      </button>
      <button
        onClick={handleCopy}
        disabled={!value}
        className="flex items-center gap-1.5 rounded-lg border border-border/60 px-3 py-1.5 text-[13px] text-text-secondary transition-all hover:bg-surface-overlay active:scale-95 disabled:opacity-40"
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
          {copied ? (
            <path
              d="M3.5 8.5l3 3 6-7"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ) : (
            <>
              <rect
                x="5"
                y="5"
                width="8"
                height="8"
                rx="1.5"
                stroke="currentColor"
                strokeWidth="1.3"
              />
              <path
                d="M3 11V3h8"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </>
          )}
        </svg>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
