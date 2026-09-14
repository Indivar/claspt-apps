// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * BulkGenerateModal — modal for generating many secrets at once and exporting
 * them to a file. The user picks a generator type and a count (1–1000), the
 * Rust backend produces the batch, and the results can be saved as TXT, CSV, or
 * JSON via the native file-save dialog.
 */
import { useCallback, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { errorMessage } from "@/lib/error-message";
import * as cmd from "@/lib/commands";
import { CloseIcon } from "@/components/ui/icons";

type GenType = "password" | "passphrase" | "memorable" | "pin" | "uuid";

/** @param onClose Called to dismiss the modal (e.g. header close button). */
export function BulkGenerateModal({ onClose }: { onClose: () => void }) {
  const [genType, setGenType] = useState<GenType>("password");
  const [count, setCount] = useState(100);
  const [results, setResults] = useState<string[]>([]);
  const [generating, setGenerating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generate = useCallback(async () => {
    setGenerating(true);
    setError(null);
    try {
      const optionsJson = defaultOptionsJson(genType);
      const r = await cmd.generateBulk(genType, optionsJson, count);
      setResults(r);
    } catch (e) {
      setError(errorMessage(e));
    }
    setGenerating(false);
  }, [genType, count]);

  // Prompt for a destination file, then write the current results in the
  // chosen format via the backend. A null filePath means the user cancelled.
  const handleExport = useCallback(
    async (format: "txt" | "csv" | "json") => {
      if (results.length === 0) return;
      setExporting(true);
      try {
        const ext = format === "json" ? "json" : format === "csv" ? "csv" : "txt";
        const filePath = await save({
          filters: [{ name: format.toUpperCase(), extensions: [ext] }],
          defaultPath: `generated-${genType}.${ext}`,
        });
        if (filePath) {
          await cmd.exportGenerated(results, filePath, format);
        }
      } catch (e) {
        setError(errorMessage(e));
      }
      setExporting(false);
    },
    [results, genType],
  );

  return (
    <div className="modal-overlay fixed inset-0 z-[60] flex items-center justify-center bg-black/40 dark:bg-black/60">
      <div className="modal-card flex h-[480px] w-[520px] flex-col overflow-hidden rounded-2xl border border-border bg-surface">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border/60 px-5 py-3">
          <h2 className="text-[13px] font-semibold text-text-primary">Bulk Generate</h2>
          <button onClick={onClose} className="icon-btn p-1 text-text-muted">
            <CloseIcon />
          </button>
        </div>

        {/* Controls */}
        <div className="flex items-end gap-3 border-b border-border/40 px-5 py-3">
          <div className="flex-1">
            <label className="mb-1 block text-[12px] text-text-muted">Type</label>
            <select
              value={genType}
              onChange={(e) => setGenType(e.target.value as GenType)}
              className="focus-accent w-full rounded-lg border border-border/60 bg-surface px-2.5 py-1.5 text-[13px] text-text-primary outline-none"
            >
              <option value="password">Password</option>
              <option value="passphrase">Passphrase</option>
              <option value="memorable">Memorable</option>
              <option value="pin">PIN</option>
              <option value="uuid">UUID</option>
            </select>
          </div>
          <div className="w-24">
            <label className="mb-1 block text-[12px] text-text-muted">Count</label>
            <input
              type="number"
              min={1}
              max={1000}
              value={count}
              onChange={(e) =>
                setCount(Math.min(1000, Math.max(1, Number(e.target.value) || 1)))
              }
              className="focus-accent w-full rounded-lg border border-border/60 bg-surface px-2.5 py-1.5 text-[13px] text-text-primary outline-none"
            />
          </div>
          <button
            onClick={generate}
            disabled={generating}
            className="rounded-lg bg-accent px-4 py-1.5 text-[13px] font-medium text-white transition-all hover:bg-accent-hover active:scale-95 disabled:opacity-60"
          >
            {generating ? "Generating..." : "Generate"}
          </button>
        </div>

        {/* Results */}
        <div className="flex-1 overflow-y-auto px-5 py-3">
          {error && <p className="mb-2 text-[12px] text-danger">{error}</p>}
          {results.length > 0 ? (
            <div className="space-y-0.5 font-mono text-[12px] text-text-primary">
              {results.map((v, i) => (
                <div key={i} className="rounded px-2 py-0.5 hover:bg-surface-overlay">
                  {v}
                </div>
              ))}
            </div>
          ) : (
            <p className="py-8 text-center text-[13px] text-text-muted">
              Configure options above and click Generate
            </p>
          )}
        </div>

        {/* Export footer */}
        {results.length > 0 && (
          <div className="flex items-center gap-2 border-t border-border/40 px-5 py-3">
            <span className="text-[12px] text-text-muted">{results.length} values</span>
            <div className="flex-1" />
            <button
              onClick={() => handleExport("txt")}
              disabled={exporting}
              className="rounded-lg border border-border/60 px-3 py-1 text-[12px] text-text-secondary transition-all hover:bg-surface-overlay active:scale-95"
            >
              Export TXT
            </button>
            <button
              onClick={() => handleExport("csv")}
              disabled={exporting}
              className="rounded-lg border border-border/60 px-3 py-1 text-[12px] text-text-secondary transition-all hover:bg-surface-overlay active:scale-95"
            >
              Export CSV
            </button>
            <button
              onClick={() => handleExport("json")}
              disabled={exporting}
              className="rounded-lg border border-border/60 px-3 py-1 text-[12px] text-text-secondary transition-all hover:bg-surface-overlay active:scale-95"
            >
              Export JSON
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Returns the default generator options for a given type, serialized as JSON.
 * Bulk generation sends options as a JSON string (rather than typed structs)
 * so a single backend command can handle every generator type uniformly.
 */
function defaultOptionsJson(genType: GenType): string {
  switch (genType) {
    case "password":
      return JSON.stringify({
        length: 20,
        uppercase: true,
        lowercase: true,
        numbers: true,
        special: true,
      });
    case "passphrase":
      return JSON.stringify({
        word_count: 5,
        separator: "-",
        capitalize: true,
        include_number: false,
        word_list: "eff",
      });
    case "memorable":
      return JSON.stringify({ style: "pronounceable", syllable_count: 4 });
    case "pin":
      return JSON.stringify({ length: 6 });
    case "uuid":
      return "{}";
  }
}
