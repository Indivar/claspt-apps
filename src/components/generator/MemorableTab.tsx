// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * MemorableTab — generates human-friendly yet strong passwords.
 *
 * Two styles (generation runs in the Rust backend):
 *  - "pronounceable": consonant-vowel syllables (e.g. bamuko-tivela), sized by
 *    syllable count — easy to say, hard to guess.
 *  - "pattern": Word + Number + Symbol (e.g. Tiger42!Moon), sized by word count.
 *
 * `onUseValue`, when provided, shows an Insert action to send the value back to
 * a secret field that opened the generator.
 */
import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "@/lib/error-message";
import * as cmd from "@/lib/commands";
import type { GenerateResult, MemorableOptions } from "@/lib/commands";
import { StrengthMeter } from "./StrengthMeter";
import { GenerateButton } from "./GenerateButton";

/** Memorable-password generator tab (pronounceable or word-pattern styles). */
export function MemorableTab({ onUseValue }: { onUseValue?: (v: string) => void }) {
  const [style, setStyle] = useState<"pronounceable" | "pattern">("pronounceable");
  const [syllableCount, setSyllableCount] = useState(4);
  const [wordCount, setWordCount] = useState(2);

  const [result, setResult] = useState<GenerateResult | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generate = useCallback(async () => {
    setGenerating(true);
    setError(null);
    try {
      const opts: MemorableOptions = {
        style,
        syllable_count: style === "pronounceable" ? syllableCount : null,
        word_count: style === "pattern" ? wordCount : null,
      };
      const r = await cmd.generateMemorable(opts);
      setResult(r);
    } catch (e) {
      setError(errorMessage(e));
    }
    setGenerating(false);
  }, [style, syllableCount, wordCount]);

  // Auto-generate on mount and option change. The async work is wrapped in an
  // IIFE so the effect body itself performs no synchronous state update.
  useEffect(() => {
    void (async () => {
      await generate();
    })();
  }, [generate]);

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border/60 bg-surface-raised px-4 py-3 font-mono text-[14px] text-text-primary break-all select-all min-h-[44px]">
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
      {error && <p className="text-[12px] text-danger">{error}</p>}

      {/* Style toggle */}
      <div className="flex rounded-lg border border-border/60 p-0.5">
        {(["pronounceable", "pattern"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setStyle(s)}
            className={`flex-1 rounded-md px-3 py-1.5 text-[13px] transition-all ${
              style === s
                ? "bg-accent/10 font-medium text-accent"
                : "text-text-secondary hover:text-text-primary"
            }`}
          >
            {s === "pronounceable" ? "Pronounceable" : "Pattern"}
          </button>
        ))}
      </div>

      <p className="text-[12px] text-text-muted">
        {style === "pronounceable"
          ? "Consonant-vowel syllables: easy to pronounce but hard to guess. Example: bamuko-tivela"
          : "Word + Number + Symbol pattern: memorable and strong. Example: Tiger42!Moon"}
      </p>

      {style === "pronounceable" ? (
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-[13px] text-text-primary">Syllables</span>
            <span className="text-[13px] text-text-muted">{syllableCount}</span>
          </div>
          <input
            type="range"
            min={3}
            max={8}
            value={syllableCount}
            onChange={(e) => setSyllableCount(Number(e.target.value))}
            className="w-full accent-accent"
          />
        </div>
      ) : (
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-[13px] text-text-primary">Words</span>
            <span className="text-[13px] text-text-muted">{wordCount}</span>
          </div>
          <input
            type="range"
            min={2}
            max={4}
            value={wordCount}
            onChange={(e) => setWordCount(Number(e.target.value))}
            className="w-full accent-accent"
          />
        </div>
      )}
    </div>
  );
}
