// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * ConsolidateDialog — modal wizard that groups credentials by domain and merges
 * them into consolidated pages. Walks through configure → preview → executing →
 * done/error steps: the user picks source folders and a target folder, previews
 * the grouping plan, then runs a limited test run or a full consolidation.
 * Execution progress is streamed from the backend via the "consolidate-progress"
 * Tauri event.
 */
import { useState, useCallback, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { errorMessage } from "@/lib/error-message";
import * as cmd from "@/lib/commands";
import { usePagesStore } from "@/stores/pages-store";
import { SpinnerIcon } from "@/components/ui/icons";
import type {
  ConsolidatePlan,
  ConsolidateProgress,
  ConsolidateResult,
} from "@/lib/commands";

type Step = "configure" | "preview" | "executing" | "done" | "error";

/** Step-driven consolidation wizard modal; `onClose` dismisses it. */
export function ConsolidateDialog({ onClose }: { onClose: () => void }) {
  const { loadPages, loadSecrets, loadFolders: refreshFolders } = usePagesStore();
  const [folders, setFolders] = useState<string[]>([]);
  const [sourceFolders, setSourceFolders] = useState<string[]>([]);
  const [targetFolder, setTargetFolder] = useState("credentials");
  const [step, setStep] = useState<Step>("configure");
  const [plan, setPlan] = useState<ConsolidatePlan | null>(null);
  const [progress, setProgress] = useState<ConsolidateProgress | null>(null);
  const [result, setResult] = useState<ConsolidateResult | null>(null);
  const [error, setError] = useState("");
  const [testLimit, setTestLimit] = useState(10);

  useEffect(() => {
    cmd.listFolders().then((f) => {
      setFolders(f);
      setSourceFolders(f);
    });
  }, []);

  const runPreview = useCallback(async () => {
    setStep("preview");
    setError("");
    try {
      const data = await cmd.utilityConsolidatePreview(sourceFolders);
      setPlan(data);
    } catch (e) {
      setError(errorMessage(e));
      setStep("error");
    }
  }, [sourceFolders]);

  const runExecute = useCallback(
    async (isTest = false) => {
      if (!plan) return;
      setStep("executing");
      setProgress(null);

      // Subscribe to backend progress events for the duration of this run only
      const unlisten = await listen<ConsolidateProgress>(
        "consolidate-progress",
        (event) => {
          setProgress(event.payload);
        },
      );

      try {
        const res = await cmd.utilityConsolidateExecute(
          plan,
          targetFolder,
          sourceFolders,
          isTest,
          isTest ? testLimit : undefined,
        );
        setResult(res);
        setStep("done");
        loadPages();
        loadSecrets();
        refreshFolders();
      } catch (e) {
        setError(errorMessage(e));
        setStep("error");
      }

      unlisten();
    },
    [
      plan,
      targetFolder,
      sourceFolders,
      testLimit,
      loadPages,
      loadSecrets,
      refreshFolders,
    ],
  );

  const toggleSource = (folder: string, checked: boolean) => {
    setSourceFolders((prev) =>
      checked ? [...prev, folder] : prev.filter((x) => x !== folder),
    );
    // Reset preview when selection changes
    if (step === "preview") setStep("configure");
    setPlan(null);
  };

  return (
    <div
      className="modal-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/40 dark:bg-black/60"
      onClick={(e) => {
        if (e.target === e.currentTarget && step !== "executing") onClose();
      }}
    >
      <div className="modal-card w-full max-w-[520px] overflow-hidden rounded-2xl border border-border bg-surface">
        {/* Header */}
        <div className="border-b border-border bg-surface-raised px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-[15px] font-semibold text-text-primary">
                Consolidate Passwords
              </h2>
              <p className="mt-0.5 text-[11px] text-text-muted">
                Group credentials by domain into consolidated pages
              </p>
            </div>
            {step !== "executing" && (
              <button
                onClick={onClose}
                className="rounded-lg p-1 text-text-muted transition-colors hover:bg-surface-overlay hover:text-text-primary"
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
            )}
          </div>
        </div>

        {/* Body */}
        <div className="max-h-[60vh] overflow-y-auto px-6 py-5">
          {/* Step: Configure */}
          {(step === "configure" || step === "preview") && (
            <div className="space-y-4">
              {/* Source folders */}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <div>
                    <label className="text-[12px] font-medium text-text-secondary">
                      Source folders to scan
                    </label>
                    <p className="text-[11px] text-text-muted">
                      {sourceFolders.length} of {folders.length} selected
                    </p>
                  </div>
                  <button
                    onClick={() => {
                      setSourceFolders(
                        sourceFolders.length === folders.length ? [] : [...folders],
                      );
                      if (step === "preview") setStep("configure");
                      setPlan(null);
                    }}
                    className="text-[11px] font-medium text-accent hover:underline"
                  >
                    {sourceFolders.length === folders.length
                      ? "Deselect all"
                      : "Select all"}
                  </button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {folders.map((f) => {
                    const selected = sourceFolders.includes(f);
                    return (
                      <button
                        key={f}
                        onClick={() => toggleSource(f, !selected)}
                        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-all ${
                          selected
                            ? "border-accent bg-accent/15 text-accent"
                            : "border-border/60 bg-transparent text-text-muted hover:border-border"
                        }`}
                      >
                        {selected && (
                          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                            <path
                              d="M2 5l2.5 2.5L8 3"
                              stroke="currentColor"
                              strokeWidth="1.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        )}
                        {f}/
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Target folder */}
              <div>
                <label className="text-[12px] font-medium text-text-secondary">
                  Consolidate into folder
                </label>
                <p className="mb-2 text-[11px] text-text-muted">
                  All consolidated pages will be created in this folder.
                </p>
                <select
                  value={targetFolder}
                  onChange={(e) => setTargetFolder(e.target.value)}
                  className="focus-accent block w-full rounded-lg border border-border/60 bg-surface-raised px-3 py-2 text-[12px] text-text-primary outline-none"
                >
                  {folders.map((f) => (
                    <option key={f} value={f}>
                      {f}/
                    </option>
                  ))}
                  {!folders.includes("credentials") && (
                    <option value="credentials">credentials/ (new)</option>
                  )}
                </select>
              </div>

              {/* Preview results */}
              {step === "preview" && plan && (
                <div className="space-y-3 rounded-xl border border-border/60 bg-surface-raised p-4">
                  <div className="space-y-1.5 text-[12px]">
                    <div className="flex justify-between">
                      <span className="text-text-muted">Pages scanned</span>
                      <span className="font-medium text-text-primary">
                        {plan.total_pages_scanned}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-text-muted">Secrets found</span>
                      <span className="font-medium text-text-primary">
                        {plan.total_secrets}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-text-muted">Domains to consolidate</span>
                      <span className="font-medium text-text-primary">
                        {plan.groups.length}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-text-muted">Credentials to move</span>
                      <span className="font-medium text-text-primary">
                        {plan.groups.reduce((sum, g) => sum + g.entries.length, 0)}
                      </span>
                    </div>
                  </div>

                  {plan.groups.length > 0 && (
                    <details className="border-t border-border/40 pt-2">
                      <summary className="cursor-pointer text-[11px] font-medium text-text-muted hover:text-text-primary">
                        Show domains ({plan.groups.length})
                      </summary>
                      <div className="mt-2 max-h-48 space-y-1.5 overflow-auto">
                        {plan.groups.map((group, i) => (
                          <div key={i} className="rounded-lg border border-border/40 p-2">
                            <div className="flex items-center justify-between">
                              <span className="text-[11px] font-medium text-accent">
                                {group.domain}
                              </span>
                              <span className="rounded-full bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                                {group.entries.length} secret
                                {group.entries.length !== 1 ? "s" : ""}
                              </span>
                            </div>
                            <div className="mt-1 space-y-0.5">
                              {group.entries.map((e, j) => (
                                <div key={j} className="text-[10px] text-text-muted">
                                  {e.label}{" "}
                                  <span className="text-text-muted/50">
                                    from {e.page_title}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}

                  {plan.groups.length === 0 && (
                    <p className="text-[11px] text-text-muted">
                      No secrets found in the selected folders. Secrets need a{" "}
                      <code className="rounded bg-surface-overlay px-1">url:</code> field
                      to be grouped by domain (those without are grouped under "other").
                    </p>
                  )}
                </div>
              )}

              {/* Loading preview */}
              {step === "preview" && !plan && (
                <div className="flex items-center justify-center gap-2 py-4 text-[12px] text-text-muted">
                  <SpinnerIcon size={14} className="animate-spin" />
                  Scanning folders...
                </div>
              )}
            </div>
          )}

          {/* Step: Executing */}
          {step === "executing" && (
            <div className="space-y-3 py-2">
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 text-[12px] text-text-primary">
                  <SpinnerIcon size={14} className="animate-spin" />
                  {progress ? progress.current_domain : "Starting..."}
                </span>
                <span className="text-[11px] font-medium text-accent">
                  {progress ? `${progress.current} / ${progress.total}` : ""}
                </span>
              </div>
              <div className="h-3 overflow-hidden rounded-full bg-border/40">
                <div
                  className="h-full rounded-full bg-accent transition-all duration-300"
                  style={{
                    width: progress
                      ? `${(progress.current / progress.total) * 100}%`
                      : "0%",
                  }}
                />
              </div>
              {progress && (
                <div className="flex justify-between text-[11px] text-text-muted">
                  <span>{progress.pages_created} pages created</span>
                  <span>{progress.secrets_moved} secrets moved</span>
                </div>
              )}
              {progress && (
                <p className="text-[10px] text-text-muted">
                  {Math.round((progress.current / progress.total) * 100)}% complete
                  {progress.total > 50 &&
                    " — this may take a few minutes for large vaults"}
                </p>
              )}
            </div>
          )}

          {/* Step: Done */}
          {step === "done" && result && (
            <div className="space-y-3 py-2">
              <div className="flex items-center gap-2">
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 20 20"
                  fill="none"
                  className="text-green-500"
                >
                  <circle cx="10" cy="10" r="9" stroke="currentColor" strokeWidth="1.5" />
                  <path
                    d="M6 10l3 3 5-6"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span className="text-[13px] font-medium text-green-500">
                  Consolidation complete
                </span>
              </div>

              <div className="space-y-1.5 rounded-xl border border-border/60 bg-surface-raised p-4 text-[12px]">
                <div className="flex justify-between">
                  <span className="text-text-muted">Pages created</span>
                  <span className="font-medium text-text-primary">
                    {result.pages_created}
                  </span>
                </div>
                {result.pages_merged > 0 && (
                  <div className="flex justify-between">
                    <span className="text-text-muted">Pages merged into existing</span>
                    <span className="font-medium text-text-primary">
                      {result.pages_merged}
                    </span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-text-muted">Secrets moved</span>
                  <span className="font-medium text-text-primary">
                    {result.secrets_moved}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-muted">Source pages deleted</span>
                  <span className="font-medium text-text-primary">
                    {result.source_pages_deleted}
                  </span>
                </div>
                {result.source_folders_deleted.length > 0 && (
                  <div className="flex justify-between">
                    <span className="text-text-muted">Source folders removed</span>
                    <span className="font-medium text-text-primary">
                      {result.source_folders_deleted.join(", ")}
                    </span>
                  </div>
                )}
                {result.folders_created.length > 0 && (
                  <div className="flex justify-between">
                    <span className="text-text-muted">New folders</span>
                    <span className="font-medium text-accent">
                      {result.folders_created.join(", ")}
                    </span>
                  </div>
                )}
              </div>

              <p className="text-[11px] text-text-muted">
                {result.source_pages_deleted === 0 &&
                result.source_folders_deleted.length === 0 ? (
                  <>
                    <strong>Test run complete.</strong> Consolidated pages are in the{" "}
                    <code className="rounded bg-surface-overlay px-1">
                      _consolidate-test/
                    </code>{" "}
                    folder. Review them, then run <strong>Full Consolidate</strong> when
                    satisfied.
                  </>
                ) : (
                  <>
                    All consolidated pages are in the{" "}
                    <code className="rounded bg-surface-overlay px-1">
                      {targetFolder}/
                    </code>{" "}
                    folder.
                  </>
                )}
              </p>
            </div>
          )}

          {/* Step: Error */}
          {step === "error" && (
            <div className="space-y-3 py-2">
              <p className="rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">
                {error}
              </p>
              <button
                onClick={() => {
                  setStep("configure");
                  setError("");
                }}
                className="text-[12px] text-accent hover:underline"
              >
                Go back
              </button>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-3">
          {step === "configure" && (
            <>
              <button
                onClick={onClose}
                className="rounded-lg border border-border/60 px-4 py-1.5 text-[12px] font-medium text-text-secondary transition-all hover:bg-surface-overlay"
              >
                Cancel
              </button>
              <button
                onClick={runPreview}
                disabled={sourceFolders.length === 0}
                className="btn-accent rounded-lg px-4 py-1.5 text-[12px] font-medium disabled:opacity-50"
              >
                Scan folders
              </button>
            </>
          )}
          {step === "preview" && plan && plan.groups.length > 0 && (
            <>
              <button
                onClick={() => {
                  setStep("configure");
                  setPlan(null);
                }}
                className="rounded-lg border border-border/60 px-4 py-1.5 text-[12px] font-medium text-text-secondary transition-all hover:bg-surface-overlay"
              >
                Back
              </button>
              <div className="flex items-center gap-1.5">
                <label className="text-[11px] text-text-muted">Test</label>
                <input
                  type="number"
                  min={1}
                  max={plan.groups.length}
                  value={testLimit}
                  onChange={(e) =>
                    setTestLimit(
                      Math.max(
                        1,
                        Math.min(plan.groups.length, parseInt(e.target.value) || 10),
                      ),
                    )
                  }
                  className="w-12 rounded border border-border/60 bg-surface-raised px-1.5 py-1 text-center text-[11px] text-text-primary"
                />
              </div>
              <button
                onClick={() => runExecute(true)}
                className="rounded-lg border border-accent/40 px-3 py-1.5 text-[12px] font-medium text-accent transition-all hover:bg-accent/10"
              >
                Test Run
              </button>
              <button
                onClick={() => runExecute(false)}
                className="btn-accent rounded-lg px-4 py-1.5 text-[12px] font-medium"
              >
                Full Consolidate
              </button>
            </>
          )}
          {step === "preview" && plan && plan.groups.length === 0 && (
            <button
              onClick={onClose}
              className="rounded-lg border border-border/60 px-4 py-1.5 text-[12px] font-medium text-text-secondary transition-all hover:bg-surface-overlay"
            >
              Close
            </button>
          )}
          {step === "done" && (
            <button
              onClick={onClose}
              className="btn-accent rounded-lg px-4 py-1.5 text-[12px] font-medium"
            >
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
