// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import React, { useState, useCallback, useEffect, useMemo } from "react";
import {generatePassword, generatePassphrase, generateMemorable, generatePin, generateUuid, estimateStrength,  } from "@/shared/generator";
import type { Message } from "@/shared/types";
import { formatTimeAgo } from "@/shared/gen-history";
import {
  recordGeneratedPassword,
  markGeneratedPasswordUsed,
  type RecordedAt,
} from "@/shared/record-generated";
import {
  unusedEntriesOlderThan,
  type StoredGeneratedEntry,
} from "@claspt/shared/generated-history";

type Mode = "password" | "passphrase" | "memorable" | "pin" | "uuid";

const MODE_LABELS: Record<Mode, string> = {
  password: "Password",
  passphrase: "Passphrase",
  memorable: "Memorable",
  pin: "PIN",
  uuid: "UUID",
};

/**
 * How old an unused password has to be before "Clear unused passwords" will
 * remove it. The floor exists so a password generated moments ago and not yet
 * pasted anywhere is never swept away mid-task; the button states the age so
 * nothing about it is hidden.
 */
const CLEAR_UNUSED_OLDER_THAN_DAYS = 30;

export function PasswordGenerator() {
  const [mode, setMode] = useState<Mode>("password");
  /** Bumped by "Regenerate"; every option change produces a new value on its own. */
  const [generation, setGeneration] = useState(0);
  /** The value a "Copied" tick refers to; the tick shows only while that value is on screen. */
  const [copiedFor, setCopiedFor] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<StoredGeneratedEntry[]>([]);
  const [copiedHistoryIdx, setCopiedHistoryIdx] = useState<number | null>(null);

  // Password options
  const [length, setLength] = useState(20);
  const [uppercase, setUppercase] = useState(true);
  const [lowercase, setLowercase] = useState(true);
  const [digits, setDigits] = useState(true);
  const [symbols, setSymbols] = useState(true);
  const [excludeAmbiguous, setExcludeAmbiguous] = useState(false);
  const [excludeProblematic, setExcludeProblematic] = useState(false);

  // Passphrase options
  const [wordCount, setWordCount] = useState(5);
  const [separator, setSeparator] = useState("-");
  const [capitalize, setCapitalize] = useState(true);
  const [includeNumber, setIncludeNumber] = useState(false);

  // Memorable options — the same two styles the desktop app and the phone offer.
  const [memStyle, setMemStyle] = useState<"pronounceable" | "pattern">("pronounceable");
  const [syllableCount, setSyllableCount] = useState(4);
  const [memWordCount, setMemWordCount] = useState(3);

  // PIN options
  const [pinLength, setPinLength] = useState(6);

  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  /** Where a generated value was stored, so Copy marks it rather than re-saving. */
  const [savedAt, setSavedAt] = useState<{ value: string; at: RecordedAt } | null>(null);
  const [clearing, setClearing] = useState(false);

  const refreshHistory = useCallback(() => {
    chrome.runtime.sendMessage({ type: "LIST_GENERATED_PASSWORDS" } as Message, (res: Message) => {
      if (res?.type === "LIST_GENERATED_PASSWORDS_RESULT") setHistory(res.entries);
    });
  }, []);

  useEffect(() => { refreshHistory(); }, [refreshHistory]);

  /** Unused entries old enough for the clear button to take. */
  const clearable = unusedEntriesOlderThan(history, CLEAR_UNUSED_OLDER_THAN_DAYS);

  const clearUnused = useCallback(() => {
    setClearing(true);
    chrome.runtime.sendMessage(
      { type: "CLEAR_UNUSED_GENERATED", days: CLEAR_UNUSED_OLDER_THAN_DAYS } as Message,
      () => {
        setClearing(false);
        refreshHistory();
      },
    );
  }, [refreshHistory]);

  const generate = useCallback(() => setGeneration((n) => n + 1), []);

  // The value on screen is a function of the options and of how many times
  // "Regenerate" was pressed. Deriving it, rather than writing it into state
  // from an effect, means no render ever shows the previous value under the
  // new options. `generation` is a dependency on purpose: a new draw under
  // the same options is the whole point of the button.
  const result = useMemo(() => {
    void generation;
    switch (mode) {
      case "password":
        return generatePassword({ length, uppercase, lowercase, digits, symbols, excludeAmbiguous, excludeProblematic });
      case "passphrase":
        return generatePassphrase({ wordCount, separator, capitalize, includeNumber });
      case "memorable":
        return generateMemorable({
          style: memStyle,
          syllableCount,
          wordCount: memWordCount,
        });
      case "pin":
        return generatePin(pinLength);
      case "uuid":
        return generateUuid();
    }
  }, [generation, mode, length, uppercase, lowercase, digits, symbols, excludeAmbiguous, excludeProblematic, wordCount, separator, capitalize, includeNumber, memStyle, syllableCount, memWordCount, pinLength]);
  const strength = useMemo(() => (result ? estimateStrength(result) : null), [result]);
  const copied = copiedFor === result;
  /** Where the value on screen was stored, if it has been stored yet. */
  const savedAtForResult = savedAt?.value === result ? savedAt.at : null;

  /**
   * Keep every generated value in the vault, a moment after it stops changing.
   *
   * Every option control regenerates, so an immediate save would write one
   * entry per slider pixel. The pause means the value the user settled on is
   * the one kept — and it is kept whether or not they go on to use it, because
   * a password rejected, regenerated past and then wanted back is exactly what
   * used to be lost.
   */
  useEffect(() => {
    if (!result) return;
    const value = result;
    const timer = setTimeout(() => {
      void recordGeneratedPassword(value, "").then((at) => {
        if (at) setSavedAt({ value, at });
        refreshHistory();
      });
    }, 700);
    return () => clearTimeout(timer);
  }, [result, refreshHistory]);

  const copyToClipboard = useCallback((text: string, onDone?: () => void) => {
    // Try chrome.runtime message first (for auto-clear), fall back to navigator.clipboard
    try {
      chrome.runtime.sendMessage(
        { type: "COPY_TO_CLIPBOARD", text, autoClear: true } as Message,
        () => {
          if (chrome.runtime.lastError) {
            // Background not available — use navigator.clipboard directly
            navigator.clipboard.writeText(text).then(onDone).catch(() => {});
          } else {
            onDone?.();
          }
        }
      );
    } catch {
      navigator.clipboard.writeText(text).then(onDone).catch(() => {});
    }
  }, []);

  const copyResult = useCallback(() => {
    if (!result || !strength) return;
    copyToClipboard(result, () => {
      setCopiedFor(result);
      setTimeout(() => setCopiedFor(null), 1500);
    });
    // The value is already kept; copying only records that it was taken up, so
    // the clear-unused sweep leaves it alone.
    void (async () => {
      const at = savedAtForResult ?? (await recordGeneratedPassword(result, ""));
      if (at) await markGeneratedPasswordUsed(at);
      refreshHistory();
    })();
  }, [result, strength, copyToClipboard, refreshHistory, savedAtForResult]);

  const copyHistoryItem = useCallback((idx: number) => {
    const entry = history[idx];
    if (!entry) return;
    void markGeneratedPasswordUsed({ pagePath: entry.pagePath, label: entry.label }).then(refreshHistory);
    copyToClipboard(entry.password, () => {
      setCopiedHistoryIdx(idx);
      setTimeout(() => setCopiedHistoryIdx(null), 1500);
    });
  }, [history, copyToClipboard, refreshHistory]);

  const toggleReveal = useCallback((idx: number) => {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return next;
    });
  }, []);

  const applyPreset = useCallback((preset: "strong" | "long" | "pin4" | "pin6" | "memorable") => {
    switch (preset) {
      case "strong":
        setMode("password"); setLength(20); setUppercase(true); setLowercase(true);
        setDigits(true); setSymbols(true); setExcludeAmbiguous(false); setExcludeProblematic(false);
        break;
      case "long":
        setMode("password"); setLength(32); setUppercase(true); setLowercase(true);
        setDigits(true); setSymbols(true); setExcludeAmbiguous(true); setExcludeProblematic(false);
        break;
      case "pin4":
        setMode("pin"); setPinLength(4);
        break;
      case "pin6":
        setMode("pin"); setPinLength(6);
        break;
      case "memorable":
        setMode("passphrase"); setWordCount(5); setSeparator("-"); setCapitalize(true); setIncludeNumber(true);
        break;
    }
  }, []);

  const strengthColors = ["text-red-600", "text-orange-500", "text-yellow-500", "text-green-500", "text-emerald-600"];
  const strengthBgColors = ["bg-red-500", "bg-orange-500", "bg-yellow-500", "bg-green-500", "bg-emerald-500"];

  if (showHistory) {
    return (
      <div className="flex flex-col gap-2 p-4 overflow-y-auto max-h-[480px]">
        <div className="flex items-center justify-between">
          <button
            onClick={() => setShowHistory(false)}
            className="flex items-center gap-1 text-xs text-accent hover:text-accent-hover transition-colors"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Back
          </button>
          <span className="text-xs font-medium text-text-secondary">
            Generated ({history.length})
          </span>
          <span className="w-10" />
        </div>

        {/* Housekeeping. Nothing expires on its own: the point of this list is
            that a password you generated is still here when you need it. */}
        <div className="flex flex-col gap-1.5 rounded-md border border-border bg-surface-raised px-2.5 py-2">
          <button
            onClick={clearUnused}
            disabled={clearing || clearable.length === 0}
            className="w-full rounded border border-border px-2 py-1 text-[10px] font-medium text-text-muted transition-colors hover:border-red-500/40 hover:text-red-500 disabled:opacity-40 disabled:hover:border-border disabled:hover:text-text-muted"
          >
            {clearing
              ? "Clearing…"
              : clearable.length === 0
                ? `Nothing to clear (unused, over ${CLEAR_UNUSED_OLDER_THAN_DAYS} days old)`
                : `Clear ${clearable.length} unused password${clearable.length === 1 ? "" : "s"} over ${CLEAR_UNUSED_OLDER_THAN_DAYS} days old`}
          </button>
          <p className="text-[9px] text-text-dim leading-tight">
            Saved in your vault, encrypted, and synced with your other devices.
            Nothing is removed on its own. Passwords you copied or filled are
            never cleared by this button.
          </p>
        </div>

        {history.length === 0 ? (
          <div className="flex flex-col items-center py-8 text-text-muted">
            <svg width="24" height="24" viewBox="0 0 16 16" fill="none" className="mb-2 text-text-dim">
              <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
              <path d="M8 5v3l2 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <p className="text-xs">No passwords generated yet</p>
            <p className="text-[10px] text-text-dim mt-1">Every one you generate is kept here</p>
          </div>
        ) : (
          history.map((entry, idx) => {
            const isRevealed = revealed.has(idx);
            const masked = entry.password.length > 4
              ? "••••••••" + entry.password.slice(-2)
              : "••••";
            const entryStrength = estimateStrength(entry.password);
            return (
              <div key={`${entry.pagePath}::${entry.label}`} className="flex flex-col gap-1 rounded-lg border border-border bg-surface-raised p-2.5">
                <div className="flex items-center gap-2">
                  <code className="flex-1 text-[11px] font-mono text-accent break-all leading-relaxed select-all">
                    {isRevealed ? entry.password : masked}
                  </code>
                  <button
                    onClick={() => toggleReveal(idx)}
                    className="shrink-0 rounded p-1 text-text-muted hover:text-accent transition-colors"
                    title={isRevealed ? "Hide" : "Reveal"}
                  >
                    {isRevealed ? (
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                        <path d="M2 2l12 12M6.5 6.5a2 2 0 002.83 2.83M3 8a8 8 0 0110-3.5M13 8a8 8 0 01-2.5 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                      </svg>
                    ) : (
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                        <path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" stroke="currentColor" strokeWidth="1.5" />
                        <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.5" />
                      </svg>
                    )}
                  </button>
                  <button
                    onClick={() => copyHistoryItem(idx)}
                    className={`shrink-0 rounded px-2 py-0.5 text-[10px] font-medium transition-colors ${
                      copiedHistoryIdx === idx
                        ? "bg-green-500/10 text-green-600"
                        : "border border-border text-text-muted hover:text-accent hover:bg-accent/10"
                    }`}
                  >
                    {copiedHistoryIdx === idx ? "Copied" : "Copy"}
                  </button>
                </div>
                <div className="flex items-center gap-2 text-[10px] text-text-dim">
                  <span className={strengthColors[entryStrength.score]}>{entryStrength.label}</span>
                  <span>{entryStrength.entropy} bits</span>
                  <span className={entry.used ? "text-accent" : "text-text-dim"}>
                    · {entry.used ? "used" : "not used"}
                  </span>
                  <span className="text-text-dim">· {entry.source}</span>
                  {entry.site && <span className="text-text-dim truncate">· {entry.site}</span>}
                  <span className="ml-auto shrink-0">{formatTimeAgo(Date.parse(entry.generated))}</span>
                </div>
              </div>
            );
          })
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-4 overflow-y-auto">
      {/* Mode toggle */}
      {/* Five modes do not fit on one row at popup width, so this wraps rather
          than squeezing the labels to the point of truncation. */}
      <div className="grid grid-cols-3 gap-1 rounded-lg border border-border p-1">
        {(Object.keys(MODE_LABELS) as Mode[]).map((m) => (
          <button
            key={m}
            className={`rounded-md py-1.5 text-xs font-medium transition-colors ${
              mode === m
                ? "bg-accent/15 text-accent"
                : "text-text-muted hover:text-text-primary hover:bg-surface-raised"
            }`}
            onClick={() => setMode(m)}
          >
            {MODE_LABELS[m]}
          </button>
        ))}
      </div>

      {/* Presets */}
      <div className="flex gap-1.5 flex-wrap">
        {[
          { id: "strong" as const, label: "Strong 20" },
          { id: "long" as const, label: "Long 32" },
          { id: "memorable" as const, label: "Memorable" },
          { id: "pin4" as const, label: "PIN 4" },
          { id: "pin6" as const, label: "PIN 6" },
        ].map((p) => (
          <button
            key={p.id}
            onClick={() => applyPreset(p.id)}
            className="rounded-full border border-border px-2 py-0.5 text-[10px] font-medium text-text-muted hover:border-accent hover:text-accent transition-colors"
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Result */}
      {result && (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-raised px-3 py-2.5">
          <code className="flex-1 text-[13px] font-mono text-accent break-all leading-relaxed select-all">{result}</code>
          <button
            onClick={copyResult}
            className={`shrink-0 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
              copied
                ? "bg-green-500/10 text-green-600"
                : "border border-border text-accent hover:bg-accent/10"
            }`}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      )}

      {/* Strength meter */}
      {strength && (
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex gap-1 flex-1 min-w-[60px]">
            {[0, 1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className={`flex-1 h-[3px] rounded-full ${
                  i <= strength.score ? strengthBgColors[strength.score] : "bg-border"
                }`}
              />
            ))}
          </div>
          <span className={`text-[11px] font-semibold ${strengthColors[strength.score]}`}>
            {strength.label}
          </span>
          <span className="text-[10px] text-text-muted">{strength.entropy} bits · {strength.crackTime}</span>
        </div>
      )}

      {/* Controls */}
      <div className="flex flex-col gap-3">
        {mode === "password" && (
          <>
            <div className="flex items-center gap-3">
              <label className="text-xs text-text-secondary min-w-[70px]">Length: {length}</label>
              <input
                type="range" min="8" max="128" value={length}
                onChange={(e) => setLength(Number(e.target.value))}
                className="flex-1 accent-accent"
              />
            </div>
            <div className="flex gap-3 flex-wrap">
              <Checkbox label="A-Z" checked={uppercase} onChange={setUppercase} />
              <Checkbox label="a-z" checked={lowercase} onChange={setLowercase} />
              <Checkbox label="0-9" checked={digits} onChange={setDigits} />
              <Checkbox label="@#!" checked={symbols} onChange={setSymbols} />
            </div>
            <Checkbox label="Exclude ambiguous (0O, 1lI)" checked={excludeAmbiguous} onChange={setExcludeAmbiguous} />
            <Checkbox label={`Exclude problematic (\\'"{}< >)`} checked={excludeProblematic} onChange={setExcludeProblematic} />
          </>
        )}

        {mode === "passphrase" && (
          <>
            <div className="flex items-center gap-3">
              <label className="text-xs text-text-secondary min-w-[70px]">Words: {wordCount}</label>
              <input
                type="range" min="3" max="10" value={wordCount}
                onChange={(e) => setWordCount(Number(e.target.value))}
                className="flex-1 accent-accent"
              />
            </div>
            <div className="flex items-center gap-3">
              <label className="text-xs text-text-secondary min-w-[70px]">Separator</label>
              <select
                value={separator}
                onChange={(e) => setSeparator(e.target.value)}
                className="flex-1 rounded-md border border-border bg-surface-raised px-2.5 py-1.5 text-xs text-text-primary outline-none focus:border-accent"
              >
                <option value="-">Hyphen (-)</option>
                <option value=" ">Space</option>
                <option value=".">Dot (.)</option>
                <option value="_">Underscore (_)</option>
              </select>
            </div>
            <div className="flex gap-3 flex-wrap">
              <Checkbox label="Capitalize" checked={capitalize} onChange={setCapitalize} />
              <Checkbox label="Include number" checked={includeNumber} onChange={setIncludeNumber} />
            </div>
          </>
        )}

        {mode === "memorable" && (
          <div className="flex flex-col gap-3">
            <div className="flex rounded-lg border border-border overflow-hidden">
              {(["pronounceable", "pattern"] as const).map((style) => (
                <button
                  key={style}
                  className={`flex-1 py-1.5 text-xs font-medium capitalize transition-colors ${
                    memStyle === style
                      ? "bg-accent/15 text-accent"
                      : "text-text-muted hover:text-text-primary hover:bg-surface-raised"
                  }`}
                  onClick={() => setMemStyle(style)}
                >
                  {style}
                </button>
              ))}
            </div>
            {memStyle === "pronounceable" ? (
              <div className="flex items-center gap-3">
                <label className="text-xs text-text-secondary min-w-[85px]">
                  Syllables: {syllableCount}
                </label>
                <input
                  type="range" min="2" max="8" value={syllableCount}
                  onChange={(e) => setSyllableCount(Number(e.target.value))}
                  className="flex-1 accent-accent"
                />
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <label className="text-xs text-text-secondary min-w-[85px]">
                  Words: {memWordCount}
                </label>
                <input
                  type="range" min="2" max="6" value={memWordCount}
                  onChange={(e) => setMemWordCount(Number(e.target.value))}
                  className="flex-1 accent-accent"
                />
              </div>
            )}
          </div>
        )}

        {mode === "uuid" && (
          <p className="text-[11px] leading-relaxed text-text-muted">
            A random version 4 UUID. No options — every one is 122 bits of
            randomness.
          </p>
        )}

        {mode === "pin" && (
          <div className="flex items-center gap-3">
            <label className="text-xs text-text-secondary min-w-[70px]">Digits: {pinLength}</label>
            <input
              type="range" min="4" max="12" value={pinLength}
              onChange={(e) => setPinLength(Number(e.target.value))}
              className="flex-1 accent-accent"
            />
          </div>
        )}

        {/* Action buttons */}
        <div className="flex gap-2">
          <button
            onClick={generate}
            className="flex-1 rounded-lg bg-accent py-2 text-sm font-semibold text-white hover:bg-accent-hover transition-colors"
          >
            Regenerate
          </button>
          <button
            onClick={() => setShowHistory(true)}
            className="relative rounded-lg border border-border px-3 py-2 text-sm text-text-muted hover:text-text-primary hover:bg-surface-raised transition-colors"
            title="Password history"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
              <path d="M8 5v3l2 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            {history.length > 0 && (
              <span className="absolute -top-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-0.5 text-[9px] font-bold text-white">
                {history.length}
              </span>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function Checkbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-1.5 text-[11px] text-text-secondary cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="rounded border-border accent-accent"
      />
      {label}
    </label>
  );
}

