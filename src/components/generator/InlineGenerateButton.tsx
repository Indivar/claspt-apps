// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * InlineGenerateButton — compact two-button control shown next to generatable
 * secret fields.
 *
 * The left button quick-generates a value tuned to the field's semantics (see
 * {@link quickGenerate}); the right ("...") button opens the full generator
 * modal wired to write back into this field.
 */
import { useCallback, useState } from "react";
import * as cmd from "@/lib/commands";
import { useUIStore } from "@/stores/ui-store";

/** Quick-generate a value based on field key semantics. */
async function quickGenerate(key: string): Promise<string> {
  const k = key.toLowerCase();
  if (k === "pin" || k === "cvv") {
    const r = await cmd.generatePin({ length: k === "cvv" ? 4 : 6 });
    return r.value;
  }
  if (k === "passphrase") {
    const r = await cmd.generatePassphrase({
      word_count: 5,
      separator: "-",
      capitalize: true,
    });
    return r.value;
  }
  if (k.includes("api")) {
    const r = await cmd.generatePassword({
      length: 32,
      uppercase: true,
      lowercase: true,
      numbers: true,
    });
    return r.value;
  }
  // Default: password
  const r = await cmd.generatePassword({
    length: 16,
    uppercase: true,
    lowercase: true,
    numbers: true,
    special: true,
  });
  return r.value;
}

/** Inline quick-generate / open-generator control for a secret field. */
export function InlineGenerateButton({
  fieldKey,
  onValue,
}: {
  fieldKey: string;
  onValue: (value: string) => void;
}) {
  const [generating, setGenerating] = useState(false);
  const { setGeneratorOpen } = useUIStore();

  const handleQuickGenerate = useCallback(async () => {
    setGenerating(true);
    try {
      const value = await quickGenerate(fieldKey);
      onValue(value);
    } catch {
      /* ignore */
    }
    setGenerating(false);
  }, [fieldKey, onValue]);

  const handleOpenFull = useCallback(() => {
    setGeneratorOpen(true, onValue);
  }, [onValue, setGeneratorOpen]);

  return (
    <div className="flex shrink-0 gap-0.5">
      <button
        onClick={handleQuickGenerate}
        disabled={generating}
        className="rounded-l px-1.5 py-0.5 text-[10px] text-accent transition-all hover:bg-accent/10 active:scale-95 disabled:opacity-50"
        title="Quick generate"
      >
        {generating ? (
          <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            className="animate-spin"
          >
            <path
              d="M14 8A6 6 0 112 8"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
            <rect
              x="1.5"
              y="1.5"
              width="5"
              height="5"
              rx="1"
              stroke="currentColor"
              strokeWidth="1.3"
            />
            <rect
              x="9.5"
              y="1.5"
              width="5"
              height="5"
              rx="1"
              stroke="currentColor"
              strokeWidth="1.3"
            />
            <rect
              x="1.5"
              y="9.5"
              width="5"
              height="5"
              rx="1"
              stroke="currentColor"
              strokeWidth="1.3"
            />
            <rect
              x="9.5"
              y="9.5"
              width="5"
              height="5"
              rx="1"
              stroke="currentColor"
              strokeWidth="1.3"
            />
            <circle cx="4" cy="4" r="0.8" fill="currentColor" />
            <circle cx="12" cy="4" r="0.8" fill="currentColor" />
            <circle cx="4" cy="12" r="0.8" fill="currentColor" />
            <circle cx="12" cy="12" r="0.8" fill="currentColor" />
          </svg>
        )}
      </button>
      <button
        onClick={handleOpenFull}
        className="rounded-r px-1 py-0.5 text-[10px] text-text-muted transition-all hover:bg-surface-overlay hover:text-text-primary"
        title="Open generator"
      >
        &hellip;
      </button>
    </div>
  );
}
