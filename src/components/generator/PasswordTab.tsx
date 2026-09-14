// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * PasswordTab — generates a random character password (the default generator).
 *
 * The character pool is built by the Rust backend from the enabled sets
 * (uppercase, lowercase, numbers, symbols) at a chosen length of 4–128.
 * Optional filters drop ambiguous glyphs (0/O, 1/l/I) or shell-problematic
 * characters (\ ' " ` { } < >). Regenerates automatically whenever an option
 * changes; `onUseValue`, when provided, shows an Insert action to return the
 * password to the calling secret field.
 */
import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "@/lib/error-message";
import * as cmd from "@/lib/commands";
import type { GenerateResult, PasswordOptions } from "@/lib/commands";
import { StrengthMeter } from "./StrengthMeter";
import { GenerateButton } from "./GenerateButton";

/** Labelled checkbox row used for the character-set and filter toggles. */
function Checkbox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-[13px] text-text-primary">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-accent"
      />
      {label}
    </label>
  );
}

/** Random-character password generator tab with configurable charset and length. */
export function PasswordTab({ onUseValue }: { onUseValue?: (v: string) => void }) {
  const [length, setLength] = useState(20);
  const [uppercase, setUppercase] = useState(true);
  const [lowercase, setLowercase] = useState(true);
  const [numbers, setNumbers] = useState(true);
  const [special, setSpecial] = useState(true);
  const [excludeAmbiguous, setExcludeAmbiguous] = useState(false);
  const [excludeProblematic, setExcludeProblematic] = useState(false);
  /**
   * Cap on symbol characters. Plenty of sites accept symbols but reject more
   * than one or two, which is why the phone and the browser extension both
   * offer this; the desktop did not, so the same settings produced a password
   * that one of the three would refuse.
   */
  const [capSymbols, setCapSymbols] = useState(false);
  const [maxSymbols, setMaxSymbols] = useState(2);

  const [result, setResult] = useState<GenerateResult | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generate = useCallback(async () => {
    setGenerating(true);
    setError(null);
    try {
      const opts: PasswordOptions = {
        length,
        uppercase,
        lowercase,
        numbers,
        special,
        exclude_ambiguous: excludeAmbiguous,
        exclude_problematic: excludeProblematic,
        max_symbols: special && capSymbols ? maxSymbols : null,
      };
      const r = await cmd.generatePassword(opts);
      setResult(r);
    } catch (e) {
      setError(errorMessage(e));
    }
    setGenerating(false);
  }, [
    length,
    uppercase,
    lowercase,
    numbers,
    special,
    excludeAmbiguous,
    excludeProblematic,
    capSymbols,
    maxSymbols,
  ]);

  // Auto-generate on mount and option change. The async work is wrapped in an
  // IIFE so the effect body itself performs no synchronous state update.
  useEffect(() => {
    void (async () => {
      await generate();
    })();
  }, [generate]);

  return (
    <div className="space-y-4">
      {/* Result */}
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

      {/* Length slider */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[13px] text-text-primary">Length</span>
          <input
            type="number"
            min={4}
            max={128}
            value={length}
            onChange={(e) => setLength(Number(e.target.value) || 4)}
            className="w-16 rounded border border-border/60 bg-surface px-2 py-0.5 text-center text-[13px] text-text-primary outline-none focus-accent"
          />
        </div>
        <input
          type="range"
          min={4}
          max={128}
          value={length}
          onChange={(e) => setLength(Number(e.target.value))}
          className="w-full accent-accent"
        />
      </div>

      {/* Character sets */}
      <div className="grid grid-cols-2 gap-2">
        <Checkbox label="Uppercase (A-Z)" checked={uppercase} onChange={setUppercase} />
        <Checkbox label="Lowercase (a-z)" checked={lowercase} onChange={setLowercase} />
        <Checkbox label="Numbers (0-9)" checked={numbers} onChange={setNumbers} />
        <Checkbox label="Symbols (!@#$)" checked={special} onChange={setSpecial} />
      </div>

      {special && (
        <div className="border-t border-border/40 pt-3 space-y-2">
          <Checkbox label="Limit symbols" checked={capSymbols} onChange={setCapSymbols} />
          {capSymbols && (
            <div className="flex items-center justify-between gap-3 pl-6">
              <span className="text-[13px] text-text-secondary">At most</span>
              <input
                type="range"
                min={0}
                max={8}
                value={maxSymbols}
                onChange={(e) => setMaxSymbols(Number(e.target.value))}
                className="flex-1 accent-accent"
              />
              <span className="w-6 text-center text-[13px] text-text-primary">
                {maxSymbols}
              </span>
            </div>
          )}
        </div>
      )}

      <div className="border-t border-border/40 pt-3 space-y-2">
        <Checkbox
          label="Exclude ambiguous (0O, 1lI)"
          checked={excludeAmbiguous}
          onChange={setExcludeAmbiguous}
        />
        <Checkbox
          label={"Exclude problematic (\\ ' \" ` { } < >)"}
          checked={excludeProblematic}
          onChange={setExcludeProblematic}
        />
      </div>
    </div>
  );
}
