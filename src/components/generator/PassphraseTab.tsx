// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * PassphraseTab — generates diceware-style passphrases (multiple random words).
 *
 * Words are chosen by the Rust backend from a selectable list — EFF Diceware
 * (7776 words) or BIP-39 (2048 words) — and joined by a configurable separator.
 * Optional capitalization and an appended random number add entropy. Larger
 * word lists and higher word counts yield stronger passphrases. `onUseValue`,
 * when provided, shows an Insert action to return the value to the calling field.
 */
import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "@/lib/error-message";
import * as cmd from "@/lib/commands";
import type { GenerateResult, PassphraseOptions } from "@/lib/commands";
import { StrengthMeter } from "./StrengthMeter";
import { GenerateButton } from "./GenerateButton";

/** Diceware-style passphrase generator tab (EFF or BIP-39 word lists). */
export function PassphraseTab({ onUseValue }: { onUseValue?: (v: string) => void }) {
  const [wordCount, setWordCount] = useState(6);
  const [separator, setSeparator] = useState("-");
  const [capitalize, setCapitalize] = useState(true);
  const [includeNumber, setIncludeNumber] = useState(false);
  const [wordList, setWordList] = useState<"eff" | "bip39">("eff");

  const [result, setResult] = useState<GenerateResult | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generate = useCallback(async () => {
    setGenerating(true);
    setError(null);
    try {
      const opts: PassphraseOptions = {
        word_count: wordCount,
        separator,
        capitalize,
        include_number: includeNumber,
        word_list: wordList,
      };
      const r = await cmd.generatePassphrase(opts);
      setResult(r);
    } catch (e) {
      setError(errorMessage(e));
    }
    setGenerating(false);
  }, [wordCount, separator, capitalize, includeNumber, wordList]);

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

      {/* Word count */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[13px] text-text-primary">Word Count</span>
          <span className="text-[13px] text-text-muted">{wordCount}</span>
        </div>
        <input
          type="range"
          min={3}
          max={12}
          value={wordCount}
          onChange={(e) => setWordCount(Number(e.target.value))}
          className="w-full accent-accent"
        />
      </div>

      {/* Options row */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-[12px] text-text-muted">Separator</label>
          <select
            value={separator}
            onChange={(e) => setSeparator(e.target.value)}
            className="focus-accent w-full rounded-lg border border-border/60 bg-surface px-2.5 py-1.5 text-[13px] text-text-primary outline-none"
          >
            <option value="-">Hyphen (-)</option>
            <option value=" ">Space</option>
            <option value=".">Dot (.)</option>
            <option value="_">Underscore (_)</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-[12px] text-text-muted">Word List</label>
          <select
            value={wordList}
            onChange={(e) => setWordList(e.target.value as "eff" | "bip39")}
            className="focus-accent w-full rounded-lg border border-border/60 bg-surface px-2.5 py-1.5 text-[13px] text-text-primary outline-none"
          >
            <option value="eff">EFF Diceware (7776)</option>
            <option value="bip39">BIP-39 (2048)</option>
          </select>
        </div>
      </div>

      <div className="flex gap-4">
        <label className="flex cursor-pointer items-center gap-2 text-[13px] text-text-primary">
          <input
            type="checkbox"
            checked={capitalize}
            onChange={(e) => setCapitalize(e.target.checked)}
            className="accent-accent"
          />
          Capitalize
        </label>
        <label className="flex cursor-pointer items-center gap-2 text-[13px] text-text-primary">
          <input
            type="checkbox"
            checked={includeNumber}
            onChange={(e) => setIncludeNumber(e.target.checked)}
            className="accent-accent"
          />
          Include number
        </label>
      </div>
    </div>
  );
}
