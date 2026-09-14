// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Modal that converts a block of selected editor text into `:::secret` block(s).
 *
 * It runs `detectCredentials()` over the selection to recognize credential-shaped
 * data (key/value pairs, ASCII/markdown tables, env `KEY=value`, `user/pass`
 * login lines), lets the user pick which detected items to include and whether to
 * emit a single combined secret or one per credential, then hands the generated
 * markdown back via `onConvert`. Detection and block generation happen entirely
 * client-side as plaintext markdown; the values are encrypted later, on save, by
 * the backend secret pipeline. This component performs no encryption itself.
 */
import { useState, useMemo } from "react";
import { detectCredentials, generateSecretBlocks } from "@/lib/credential-detector";

interface ConvertToSecretModalProps {
  selectedText: string;
  suggestedLabel: string;
  onConvert: (secretBlocks: string) => void;
  onClose: () => void;
}

/**
 * Renders the credential-detection UI (or an empty-state when nothing is
 * detected) and, on confirm, returns the generated secret-block markdown.
 */
export function ConvertToSecretModal({
  selectedText,
  suggestedLabel,
  onConvert,
  onClose,
}: ConvertToSecretModalProps) {
  const detected = useMemo(() => detectCredentials(selectedText), [selectedText]);
  const [label, setLabel] = useState(suggestedLabel || "Credentials");
  const [mode, setMode] = useState<"one" | "separate">("one");
  const [included, setIncluded] = useState<Set<number>>(
    () => new Set(detected.map((_, i) => i)),
  );

  const activeCredentials = detected.filter((_, i) => included.has(i));

  const preview = useMemo(
    () => generateSecretBlocks(activeCredentials, label, mode),
    [activeCredentials, label, mode],
  );

  function toggleItem(index: number) {
    setIncluded((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }

  function handleConvert() {
    if (activeCredentials.length === 0) return;
    onConvert(preview);
  }

  const sourceIcon: Record<string, string> = {
    table: "Table",
    "markdown-table": "Table",
    colon: "Key: Value",
    equals: "ENV",
    slash: "Login",
  };

  if (detected.length === 0) {
    return (
      <div
        className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className="w-full max-w-md rounded-2xl border border-border bg-surface p-6 shadow-2xl">
          <h2 className="text-[15px] font-semibold text-text-primary mb-2">
            No Credentials Detected
          </h2>
          <p className="text-[13px] text-text-muted mb-4 leading-relaxed">
            Could not find any credential patterns in the selected text. Supported
            formats: key-value pairs, ASCII tables, env variables, and email/password
            lines.
          </p>
          <div className="rounded-lg bg-surface-raised p-3 max-h-32 overflow-auto mb-4">
            <pre className="text-[11px] text-text-dim whitespace-pre-wrap break-all">
              {selectedText.slice(0, 500)}
              {selectedText.length > 500 ? "..." : ""}
            </pre>
          </div>
          <div className="flex justify-end">
            <button
              onClick={onClose}
              className="rounded-lg border border-border/60 px-4 py-1.5 text-[12px] font-medium text-text-secondary hover:bg-surface-overlay"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-lg rounded-2xl border border-border bg-surface shadow-2xl">
        {/* Header */}
        <div className="border-b border-border bg-surface-raised px-5 py-3.5 rounded-t-2xl">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-[15px] font-semibold text-text-primary">
                Convert to Secret{detected.length > 1 ? "s" : ""}
              </h2>
              <p className="mt-0.5 text-[11px] text-text-muted">
                {detected.length} credential{detected.length !== 1 ? "s" : ""} detected
              </p>
            </div>
            <button
              onClick={onClose}
              className="rounded-lg p-1 text-text-muted hover:bg-surface-overlay hover:text-text-primary"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path
                  d="M4 4l8 8M12 4l-8 8"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="max-h-[60vh] overflow-y-auto px-5 py-4 space-y-4">
          {/* Mode toggle */}
          <div className="flex items-center gap-1 rounded-lg bg-surface-raised p-1">
            <button
              onClick={() => setMode("one")}
              className={`flex-1 rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors ${
                mode === "one"
                  ? "bg-accent text-background shadow-sm"
                  : "text-text-muted hover:text-text-primary"
              }`}
            >
              One Secret
            </button>
            <button
              onClick={() => setMode("separate")}
              className={`flex-1 rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors ${
                mode === "separate"
                  ? "bg-accent text-background shadow-sm"
                  : "text-text-muted hover:text-text-primary"
              }`}
            >
              Separate Secrets
            </button>
          </div>

          {/* Label input */}
          {mode === "one" && (
            <div>
              <label className="text-[11px] font-medium text-text-muted mb-1 block">
                Secret Label
              </label>
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Enter label..."
                className="w-full rounded-lg border border-border/60 bg-surface-raised px-3 py-2 text-[13px] text-text-primary outline-none focus:border-accent"
              />
            </div>
          )}

          {/* Detected credentials list */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-[11px] font-medium text-text-muted">
                Detected Credentials
              </label>
              <button
                onClick={() => {
                  if (included.size === detected.length) {
                    setIncluded(new Set());
                  } else {
                    setIncluded(new Set(detected.map((_, i) => i)));
                  }
                }}
                className="text-[10px] text-accent hover:underline"
              >
                {included.size === detected.length ? "Deselect all" : "Select all"}
              </button>
            </div>
            <div className="space-y-1 max-h-48 overflow-y-auto rounded-lg border border-border/40 p-1">
              {detected.map((cred, i) => (
                <label
                  key={i}
                  className={`flex items-start gap-2 rounded-md px-2.5 py-2 cursor-pointer transition-colors ${
                    included.has(i) ? "bg-accent/5" : "opacity-40"
                  } hover:bg-accent/10`}
                >
                  <input
                    type="checkbox"
                    checked={included.has(i)}
                    onChange={() => toggleItem(i)}
                    className="mt-0.5 rounded border-border"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[12px] font-medium text-text-primary truncate">
                        {cred.key}
                      </span>
                      <span className="shrink-0 rounded bg-surface-overlay px-1.5 py-px text-[9px] text-text-dim">
                        {sourceIcon[cred.source] ?? cred.source}
                      </span>
                    </div>
                    <span className="text-[11px] text-text-muted truncate block mt-0.5">
                      {cred.value.length > 60
                        ? cred.value.slice(0, 60) + "..."
                        : cred.value}
                    </span>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* Preview */}
          {activeCredentials.length > 0 && (
            <details className="border-t border-border/40 pt-3">
              <summary className="cursor-pointer text-[11px] font-medium text-text-muted hover:text-text-primary">
                Preview output
              </summary>
              <pre className="mt-2 rounded-lg bg-surface-raised p-3 text-[11px] text-text-secondary whitespace-pre-wrap break-all max-h-40 overflow-auto font-mono">
                {preview}
              </pre>
            </details>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-border px-5 py-3 rounded-b-2xl">
          <span className="text-[11px] text-text-dim">
            {activeCredentials.length} of {detected.length} selected
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="rounded-lg border border-border/60 px-4 py-1.5 text-[12px] font-medium text-text-secondary hover:bg-surface-overlay"
            >
              Cancel
            </button>
            <button
              onClick={handleConvert}
              disabled={activeCredentials.length === 0}
              className="btn-accent rounded-lg px-4 py-1.5 text-[12px] font-medium disabled:opacity-50"
            >
              Convert{" "}
              {mode === "one"
                ? "to 1 Secret"
                : `to ${activeCredentials.length} Secret${activeCredentials.length !== 1 ? "s" : ""}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
