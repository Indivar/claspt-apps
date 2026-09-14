// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * UuidTab — generates a random UUID v4 (122 bits of randomness).
 *
 * Suitable for unique identifiers, API keys, and correlation IDs. Copying to
 * the clipboard auto-clears it after 30 seconds; `onUseValue`, when provided,
 * shows an Insert action to return the UUID to the calling secret field.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import * as cmd from "@/lib/commands";
import { copyToClipboard, clearClipboardAfter } from "@/lib/clipboard";

/** UUID v4 generator tab with auto-clearing clipboard copy. */
export function UuidTab({ onUseValue }: { onUseValue?: (v: string) => void }) {
  const [value, setValue] = useState("");
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const generate = useCallback(async () => {
    try {
      const uuid = await cmd.generateUuid();
      setValue(uuid);
    } catch {
      /* ignore */
    }
  }, []);

  // Generate on mount. The async work is wrapped in an IIFE so the effect body
  // itself performs no synchronous state update.
  useEffect(() => {
    void (async () => {
      await generate();
    })();
  }, [generate]);

  const handleCopy = useCallback(async () => {
    if (!value) return;
    const ok = await copyToClipboard(value);
    if (ok) {
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = clearClipboardAfter(30_000);
    }
  }, [value]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border/60 bg-surface-raised px-4 py-3 font-mono text-[14px] text-text-primary select-all min-h-[44px]">
        {value}
      </div>

      <div className="flex gap-2">
        <button
          onClick={generate}
          className="flex items-center gap-1.5 rounded-lg bg-accent px-4 py-1.5 text-[13px] font-medium text-white transition-all hover:bg-accent-hover active:scale-95"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
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
          Regenerate
        </button>
        <button
          onClick={handleCopy}
          disabled={!value}
          className="flex items-center gap-1.5 rounded-lg border border-border/60 px-3 py-1.5 text-[13px] text-text-secondary transition-all hover:bg-surface-overlay active:scale-95 disabled:opacity-40"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      {onUseValue && value && (
        <button
          onClick={() => onUseValue(value)}
          className="w-full rounded-lg border border-accent/40 bg-accent/5 px-4 py-1.5 text-[13px] font-medium text-accent transition-all hover:bg-accent/10 active:scale-[0.98]"
        >
          Insert
        </button>
      )}

      <p className="text-[12px] text-text-muted">
        UUID v4 — 122 bits of randomness. Suitable for unique identifiers, API keys, and
        correlation IDs.
      </p>
    </div>
  );
}
