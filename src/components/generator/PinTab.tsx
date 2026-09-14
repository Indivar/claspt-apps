// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * PinTab — generates a numeric PIN (digits only) of 4–12 digits.
 *
 * Digits are drawn by the Rust backend. `onUseValue`, when provided, shows an
 * Insert action to return the PIN to the secret field that opened the generator.
 */
import { useCallback, useEffect, useState } from "react";
import * as cmd from "@/lib/commands";
import type { GenerateResult } from "@/lib/commands";
import { StrengthMeter } from "./StrengthMeter";
import { GenerateButton } from "./GenerateButton";

/** Numeric-PIN generator tab (4–12 digits). */
export function PinTab({ onUseValue }: { onUseValue?: (v: string) => void }) {
  const [length, setLength] = useState(6);
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [generating, setGenerating] = useState(false);

  const generate = useCallback(async () => {
    setGenerating(true);
    try {
      const r = await cmd.generatePin({ length });
      setResult(r);
    } catch {
      /* ignore */
    }
    setGenerating(false);
  }, [length]);

  // Auto-generate on mount and option change. The async work is wrapped in an
  // IIFE so the effect body itself performs no synchronous state update.
  useEffect(() => {
    void (async () => {
      await generate();
    })();
  }, [generate]);

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border/60 bg-surface-raised px-4 py-3 text-center font-mono text-[24px] tracking-[0.3em] text-text-primary select-all min-h-[52px]">
        {result?.value ?? ""}
      </div>

      <GenerateButton
        value={result?.value ?? ""}
        onGenerate={generate}
        generating={generating}
      />
      {onUseValue && result?.value && (
        <button
          onClick={() => onUseValue(result.value)}
          className="w-full rounded-lg border border-accent/40 bg-accent/5 px-4 py-1.5 text-[13px] font-medium text-accent transition-all hover:bg-accent/10 active:scale-[0.98]"
        >
          Insert
        </button>
      )}

      <StrengthMeter result={result?.strength ?? null} />

      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[13px] text-text-primary">Digits</span>
          <span className="text-[13px] text-text-muted">{length}</span>
        </div>
        <input
          type="range"
          min={4}
          max={12}
          value={length}
          onChange={(e) => setLength(Number(e.target.value))}
          className="w-full accent-accent"
        />
      </div>
    </div>
  );
}
