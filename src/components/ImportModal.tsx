// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * ImportModal — multi-step wizard for importing external data into the vault.
 *
 * Supports a single Markdown file (imported as one page) and several password-manager
 * CSV/XML formats (LastPass, 1Password, RoboForm, KeePass) plus a Generic CSV path that
 * lets the user map columns to field roles. Bulk imports create pages with encrypted
 * secret blocks and stream progress via a Tauri "import-progress" event.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import * as cmd from "@/lib/commands";
import { errorMessage } from "@/lib/error-message";
import { useUIStore } from "@/stores/ui-store";
import { usePagesStore } from "@/stores/pages-store";
import type {
  CsvColumnMapping,
  DuplicateStrategy,
  ImportEntry,
  ImportFormat,
  ImportResult,
  MarkdownImportPreview,
} from "@claspt/shared/types";

interface ImportProgress {
  imported: number;
  skipped: number;
  total: number;
}

/**
 * Wizard steps. "mapping" is only used for Generic CSV (column-role mapping); Markdown
 * and known password-manager formats go straight from "select" to "preview".
 */
type Step = "select" | "mapping" | "preview" | "done";

const FORMATS: { value: ImportFormat; label: string; ext: string }[] = [
  { value: "Markdown", label: "Markdown File", ext: "md" },
  { value: "GenericCsv", label: "Generic CSV", ext: "csv" },
  { value: "LastPass", label: "LastPass CSV", ext: "csv" },
  { value: "OnePassword", label: "1Password CSV", ext: "csv" },
  { value: "RoboForm", label: "RoboForm CSV", ext: "csv" },
  { value: "KeePass", label: "KeePass XML", ext: "xml" },
];

const ROLE_OPTIONS: { value: string; label: string }[] = [
  { value: "title", label: "Title" },
  { value: "username", label: "Username" },
  { value: "password", label: "Password" },
  { value: "email", label: "Email" },
  { value: "url", label: "URL" },
  { value: "otp", label: "OTP" },
  { value: "notes", label: "Notes" },
  { value: "folder", label: "Folder" },
  { value: "field", label: "Field (as-is)" },
  { value: "skip", label: "Skip" },
];

/**
 * The stateful wizard body. Owns the current step, chosen format/file, previews,
 * duplicate strategy, and CSV column mappings, and dispatches the Tauri import commands.
 * Only mounted while the modal is open so its state resets between opens.
 */
function ImportContent({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<Step>("select");
  const [format, setFormat] = useState<ImportFormat>("Markdown");
  const [filePath, setFilePath] = useState<string | null>(null);
  const [entries, setEntries] = useState<ImportEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const loadPages = usePagesStore((s) => s.loadPages);

  // Progress state for bulk import
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);

  // Markdown-specific state
  const [mdPreview, setMdPreview] = useState<MarkdownImportPreview | null>(null);
  const [mdTitle, setMdTitle] = useState("");
  const [mdFolder, setMdFolder] = useState("general");
  const [mdTags, setMdTags] = useState("");
  const [folders, setFolders] = useState<string[]>([]);
  const [mdImportedTitle, setMdImportedTitle] = useState("");

  // Duplicate strategy for bulk imports
  const [dupStrategy, setDupStrategy] = useState<DuplicateStrategy>("skip");

  // CSV column mapping state (GenericCsv only)
  const [csvMappings, setCsvMappings] = useState<CsvColumnMapping[]>([]);

  const isMarkdown = format === "Markdown";
  const isGenericCsv = format === "GenericCsv";

  // Close on Escape
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
      // Clean up progress listener if component unmounts during import
      unlistenRef.current?.();
    };
  }, [onClose]);

  const handlePickFile = useCallback(async () => {
    const fmt = FORMATS.find((f) => f.value === format);
    const selected = await open({
      multiple: false,
      filters: [
        {
          name: isMarkdown ? "Markdown" : "Import File",
          extensions: isMarkdown ? ["md", "markdown"] : [fmt?.ext ?? "csv"],
        },
      ],
    });
    if (selected) {
      setFilePath(selected);
      setError(null);
    }
  }, [format, isMarkdown]);

  const handlePreview = useCallback(async () => {
    if (!filePath) return;
    setLoading(true);
    setError(null);
    try {
      if (isMarkdown) {
        const [preview, folderList] = await Promise.all([
          cmd.previewMarkdownImport(filePath),
          cmd.listFolders(),
        ]);
        setMdPreview(preview);
        setMdTitle(preview.title);
        setMdFolder(preview.suggested_folder);
        setMdTags(preview.tags.join(", "));
        setFolders(folderList);
        setStep("preview");
      } else if (isGenericCsv) {
        const mappings = await cmd.detectCsvColumns(filePath);
        setCsvMappings(mappings);
        setStep("mapping");
      } else {
        const result = await cmd.previewImport(filePath, format);
        setEntries(result);
        setStep("preview");
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [filePath, format, isMarkdown, isGenericCsv]);

  const handleApplyMappings = useCallback(async () => {
    if (!filePath) return;
    setLoading(true);
    setError(null);
    try {
      const result = await cmd.previewImport(filePath, format, csvMappings);
      setEntries(result);
      setStep("preview");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [filePath, format, csvMappings]);

  const handleImport = useCallback(async () => {
    if (!filePath) return;
    setLoading(true);
    setError(null);
    setProgress(null);
    try {
      if (isMarkdown) {
        const tags = mdTags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
        await cmd.importMarkdownPage(filePath, mdTitle, mdFolder, tags);
        setMdImportedTitle(mdTitle);
      } else {
        // Listen for progress events during bulk import
        const unlisten = await listen<ImportProgress>("import-progress", (event) => {
          setProgress(event.payload);
        });
        unlistenRef.current = unlisten;
        try {
          const result = await cmd.executeImport(
            filePath,
            format,
            dupStrategy,
            isGenericCsv ? csvMappings : null,
          );
          setImportResult(result);
        } finally {
          unlisten();
          unlistenRef.current = null;
        }
      }
      setStep("done");
      await loadPages();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
      setProgress(null);
    }
  }, [
    filePath,
    format,
    isMarkdown,
    isGenericCsv,
    csvMappings,
    mdTitle,
    mdFolder,
    mdTags,
    dupStrategy,
    loadPages,
  ]);

  const handleBack = useCallback(() => {
    if (step === "preview" && isGenericCsv) {
      // Go back to mapping step, not all the way to select
      setStep("mapping");
      setEntries([]);
      setError(null);
      return;
    }
    setStep("select");
    setEntries([]);
    setMdPreview(null);
    setCsvMappings([]);
    setError(null);
    setDupStrategy("skip");
  }, [step, isGenericCsv]);

  return (
    <div className="modal-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/30 dark:bg-black/50">
      <div className="modal-card flex w-[560px] flex-col overflow-hidden rounded-2xl border border-border/60 bg-surface shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border/60 px-6 py-4">
          <h2 className="text-[13px] font-semibold text-text-primary">Import</h2>
          <button onClick={onClose} className="icon-btn p-1 text-text-muted">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path
                d="M4 4l8 8M12 4l-8 8"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {step === "select" && (
            <div className="space-y-4">
              {/* Format selector */}
              <div>
                <label className="mb-1.5 block text-xs font-medium text-text-muted">
                  Source Format
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {FORMATS.map((f) => (
                    <button
                      key={f.value}
                      onClick={() => {
                        setFormat(f.value);
                        setFilePath(null);
                        setError(null);
                      }}
                      className={`rounded-xl border px-3 py-2.5 text-left text-[13px] transition-all ${
                        format === f.value
                          ? "border-accent bg-accent/10 text-accent shadow-sm"
                          : "border-border/60 text-text-secondary hover:border-text-muted hover:bg-surface-raised/50"
                      }`}
                    >
                      <span className="font-medium">{f.label}</span>
                      <span className="ml-1 text-[11px] text-text-muted">.{f.ext}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* File picker */}
              <div>
                <label className="mb-1.5 block text-xs font-medium text-text-muted">
                  File
                </label>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handlePickFile}
                    className="rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-text-secondary transition-colors hover:border-accent hover:text-accent"
                  >
                    Choose File
                  </button>
                  {filePath && (
                    <span className="truncate text-sm text-text-muted">
                      {filePath.split("/").pop()}
                    </span>
                  )}
                </div>
              </div>

              {error && (
                <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
                  {error}
                </p>
              )}
            </div>
          )}

          {step === "mapping" && isGenericCsv && (
            <div className="space-y-3">
              <p className="text-sm text-text-secondary">
                Auto-detected column mappings. Adjust if needed:
              </p>
              <div className="max-h-[320px] overflow-y-auto rounded-lg border border-border">
                <table className="w-full text-left text-sm">
                  <thead className="sticky top-0 bg-surface-raised">
                    <tr className="border-b border-border">
                      <th className="px-3 py-2 font-medium text-text-muted">
                        CSV Column
                      </th>
                      <th className="px-3 py-2 font-medium text-text-muted">Maps To</th>
                    </tr>
                  </thead>
                  <tbody>
                    {csvMappings.map((m, i) => (
                      <tr key={i} className="border-b border-border last:border-0">
                        <td className="px-3 py-1.5 font-mono text-xs text-text-primary">
                          {m.header}
                        </td>
                        <td className="px-3 py-1.5">
                          <select
                            value={m.role}
                            onChange={(e) => {
                              const updated = [...csvMappings];
                              updated[i] = { ...m, role: e.target.value };
                              setCsvMappings(updated);
                            }}
                            className="w-full rounded-md border border-border bg-surface-raised px-2 py-1 text-xs text-text-primary outline-none focus:border-accent"
                          >
                            {ROLE_OPTIONS.map((opt) => (
                              <option key={opt.value} value={opt.value}>
                                {opt.label}
                              </option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {error && (
                <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
                  {error}
                </p>
              )}
            </div>
          )}

          {step === "preview" && isMarkdown && mdPreview && (
            <div className="space-y-3">
              {/* Title */}
              <div>
                <label className="mb-1 block text-xs font-medium text-text-muted">
                  Title
                </label>
                <input
                  type="text"
                  value={mdTitle}
                  onChange={(e) => setMdTitle(e.target.value)}
                  className="w-full rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-text-primary outline-none focus:border-accent"
                />
              </div>

              {/* Folder */}
              <div>
                <label className="mb-1 block text-xs font-medium text-text-muted">
                  Folder
                </label>
                <select
                  value={mdFolder}
                  onChange={(e) => setMdFolder(e.target.value)}
                  className="w-full rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-text-primary outline-none focus:border-accent"
                >
                  {folders.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                  {!folders.includes(mdFolder) && (
                    <option value={mdFolder}>{mdFolder}</option>
                  )}
                </select>
              </div>

              {/* Tags */}
              <div>
                <label className="mb-1 block text-xs font-medium text-text-muted">
                  Tags (comma-separated)
                </label>
                <input
                  type="text"
                  value={mdTags}
                  onChange={(e) => setMdTags(e.target.value)}
                  placeholder="tag1, tag2"
                  className="w-full rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-text-primary outline-none focus:border-accent"
                />
              </div>

              {/* Info row */}
              <div className="flex gap-3 text-xs text-text-muted">
                <span>{mdPreview.word_count} words</span>
                {mdPreview.has_frontmatter && <span>Has frontmatter</span>}
              </div>

              {/* Content preview */}
              <div>
                <label className="mb-1 block text-xs font-medium text-text-muted">
                  Content Preview
                </label>
                <div className="max-h-[120px] overflow-y-auto rounded-lg border border-border bg-surface-raised p-3 font-mono text-xs text-text-secondary">
                  {mdPreview.content_preview || "(empty)"}
                </div>
              </div>

              {/* Warnings */}
              {mdPreview.warnings.length > 0 && (
                <div className="space-y-1.5">
                  {mdPreview.warnings.map((w, i) => (
                    <div
                      key={i}
                      className={`rounded-lg px-3 py-2 text-xs ${
                        mdPreview.duplicate_exists && w.includes("already exists")
                          ? "bg-danger/10 text-danger"
                          : "bg-warning/10 text-warning"
                      }`}
                    >
                      {w}
                    </div>
                  ))}
                </div>
              )}

              {error && (
                <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
                  {error}
                </p>
              )}
            </div>
          )}

          {step === "preview" && !isMarkdown && (
            <div className="space-y-3">
              <p className="text-sm text-text-secondary">
                Found{" "}
                <span className="font-semibold text-text-primary">{entries.length}</span>{" "}
                entries to import:
              </p>

              {/* Duplicate strategy selector */}
              {!progress && (
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-text-muted">
                    If duplicates are found
                  </label>
                  <div className="flex flex-col gap-1.5">
                    {(
                      [
                        {
                          value: "skip",
                          label: "Skip duplicates",
                          desc: "Don\u2019t import entries that already exist",
                        },
                        {
                          value: "overwrite",
                          label: "Overwrite existing",
                          desc: "Replace existing page content with imported version",
                        },
                        {
                          value: "import_as_new",
                          label: "Import as new",
                          desc: "Create with a numbered suffix on the title",
                        },
                      ] as const
                    ).map((opt) => (
                      <label
                        key={opt.value}
                        className={`flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 transition-all ${
                          dupStrategy === opt.value
                            ? "border-accent bg-accent/5"
                            : "border-border/60 hover:border-text-muted"
                        }`}
                      >
                        <input
                          type="radio"
                          name="dupStrategy"
                          value={opt.value}
                          checked={dupStrategy === opt.value}
                          onChange={() => setDupStrategy(opt.value)}
                          className="mt-0.5 accent-accent"
                        />
                        <div>
                          <span className="text-[13px] font-medium text-text-primary">
                            {opt.label}
                          </span>
                          <p className="text-[11px] text-text-muted">{opt.desc}</p>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {!progress && (
                <div className="max-h-[300px] overflow-y-auto rounded-lg border border-border">
                  <table className="w-full text-left text-sm">
                    <thead className="sticky top-0 bg-surface-raised">
                      <tr className="border-b border-border">
                        <th className="px-3 py-2 font-medium text-text-muted">Title</th>
                        <th className="px-3 py-2 font-medium text-text-muted">Folder</th>
                        <th className="px-3 py-2 font-medium text-text-muted">Fields</th>
                      </tr>
                    </thead>
                    <tbody>
                      {entries.map((entry, i) => (
                        <tr key={i} className="border-b border-border last:border-0">
                          <td className="max-w-[180px] truncate px-3 py-2 text-text-primary">
                            {entry.title}
                          </td>
                          <td className="px-3 py-2 text-text-muted">
                            {entry.folder || "general"}
                          </td>
                          <td className="px-3 py-2 text-text-muted">
                            {entry.fields.length}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {progress && (
                <div className="space-y-2 py-4">
                  <div className="flex items-center justify-between text-xs text-text-muted">
                    <span>
                      Importing... {progress.imported + progress.skipped} /{" "}
                      {progress.total}
                    </span>
                    <span>
                      {Math.round(
                        ((progress.imported + progress.skipped) / progress.total) * 100,
                      )}
                      %
                    </span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-surface-raised">
                    <div
                      className="h-full rounded-full bg-accent transition-all duration-200"
                      style={{
                        width: `${((progress.imported + progress.skipped) / progress.total) * 100}%`,
                      }}
                    />
                  </div>
                  <p className="text-xs text-text-muted">
                    {progress.imported} imported
                    {progress.skipped > 0
                      ? `, ${progress.skipped} duplicates skipped`
                      : ""}
                  </p>
                </div>
              )}
              {error && (
                <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
                  {error}
                </p>
              )}
            </div>
          )}

          {step === "done" && isMarkdown && (
            <div className="flex flex-col items-center py-8">
              <svg
                width="48"
                height="48"
                viewBox="0 0 48 48"
                fill="none"
                className="mb-4 text-success"
              >
                <circle cx="24" cy="24" r="20" stroke="currentColor" strokeWidth="2" />
                <path
                  d="M16 24l6 6 10-12"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <p className="text-sm font-medium text-text-primary">
                Successfully imported page: {mdImportedTitle}
              </p>
            </div>
          )}

          {step === "done" && !isMarkdown && importResult && (
            <div className="flex flex-col items-center py-8">
              <svg
                width="48"
                height="48"
                viewBox="0 0 48 48"
                fill="none"
                className="mb-4 text-success"
              >
                <circle cx="24" cy="24" r="20" stroke="currentColor" strokeWidth="2" />
                <path
                  d="M16 24l6 6 10-12"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <p className="text-sm font-medium text-text-primary">
                Successfully imported {importResult.imported} of {importResult.total}{" "}
                entries
              </p>
              {importResult.skipped > 0 && (
                <p className="mt-1 text-xs text-text-muted">
                  {importResult.skipped} duplicate{importResult.skipped > 1 ? "s" : ""}{" "}
                  skipped
                </p>
              )}
              {importResult.imported > 0 &&
                importResult.imported === importResult.total &&
                importResult.skipped === 0 && (
                  <p className="mt-1 text-xs text-text-muted">
                    All entries imported successfully
                  </p>
                )}
              <p className="mt-1 text-xs text-text-muted">
                Pages have been created with encrypted secret blocks.
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-border/60 px-6 py-3">
          <div>
            {(step === "mapping" || step === "preview") && (
              <button
                onClick={handleBack}
                className="rounded-lg px-4 py-1.5 text-[13px] text-text-secondary transition-all hover:bg-surface-overlay active:scale-95"
              >
                Back
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="rounded-lg px-4 py-1.5 text-[13px] text-text-secondary transition-all hover:bg-surface-overlay active:scale-95"
            >
              {step === "done" ? "Close" : "Cancel"}
            </button>
            {step === "select" && (
              <button
                onClick={handlePreview}
                disabled={!filePath || loading}
                className="rounded-lg bg-accent px-5 py-1.5 text-[13px] font-medium text-white transition-all hover:bg-accent-hover hover:shadow-md active:scale-95 disabled:opacity-50"
              >
                {loading ? "Loading..." : "Preview"}
              </button>
            )}
            {step === "mapping" && (
              <button
                onClick={handleApplyMappings}
                disabled={loading}
                className="rounded-lg bg-accent px-5 py-1.5 text-[13px] font-medium text-white transition-all hover:bg-accent-hover hover:shadow-md active:scale-95 disabled:opacity-50"
              >
                {loading ? "Loading..." : "Continue"}
              </button>
            )}
            {step === "preview" && isMarkdown && (
              <button
                onClick={handleImport}
                disabled={loading || !mdTitle.trim()}
                className="rounded-lg bg-accent px-5 py-1.5 text-[13px] font-medium text-white transition-all hover:bg-accent-hover hover:shadow-md active:scale-95 disabled:opacity-50"
              >
                {loading ? "Importing..." : "Import Page"}
              </button>
            )}
            {step === "preview" && !isMarkdown && (
              <button
                onClick={handleImport}
                disabled={loading || entries.length === 0}
                className="rounded-lg bg-accent px-5 py-1.5 text-[13px] font-medium text-white transition-all hover:bg-accent-hover hover:shadow-md active:scale-95 disabled:opacity-50"
              >
                {loading ? "Importing..." : `Import ${entries.length} Entries`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Modal entry point wired to the UI store. Renders nothing until the import modal is
 * opened, then mounts a fresh {@link ImportContent} so wizard state starts clean each time.
 */
export function ImportModal() {
  const { importModalOpen, setImportModalOpen } = useUIStore();

  if (!importModalOpen) return null;

  return <ImportContent onClose={() => setImportModalOpen(false)} />;
}
