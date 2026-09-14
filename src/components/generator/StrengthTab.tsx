// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * StrengthTab — checks the strength of an arbitrary password the user types or
 * pastes in. Does NOT generate anything.
 *
 * Analysis runs locally in the Rust backend (nothing is stored or transmitted);
 * checks are debounced by 200ms and results include a strength meter plus
 * improvement suggestions.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import * as cmd from "@/lib/commands";
import type { StrengthResult } from "@/lib/commands";
import { StrengthMeter } from "./StrengthMeter";

/** Password-strength checker tab for user-supplied passwords. */
export function StrengthTab() {
  const [password, setPassword] = useState("");
  const [result, setResult] = useState<StrengthResult | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const check = useCallback(async (value: string) => {
    if (!value) {
      setResult(null);
      return;
    }
    try {
      const r = await cmd.checkPasswordStrength(value);
      setResult(r);
    } catch {
      /* ignore */
    }
  }, []);

  // Debounced strength check
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => check(password), 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [password, check]);

  return (
    <div className="space-y-4">
      <p className="text-[13px] text-text-secondary">
        Paste or type any password to check its strength. Nothing is stored or
        transmitted.
      </p>

      <input
        type="text"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Enter a password to check..."
        className="focus-accent w-full rounded-lg border border-border/60 bg-surface px-4 py-2.5 font-mono text-[14px] text-text-primary outline-none"
        autoFocus
      />

      <StrengthMeter result={result} />

      {result && result.suggestions.length > 0 && (
        <div className="space-y-1">
          <p className="text-[12px] font-medium text-text-muted">Suggestions</p>
          <ul className="space-y-0.5">
            {result.suggestions.map((s, i) => (
              <li
                key={i}
                className="flex items-start gap-2 text-[12px] text-text-secondary"
              >
                <span className="mt-0.5 text-accent">&#x2022;</span>
                {s}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
