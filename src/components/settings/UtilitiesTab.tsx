// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * UtilitiesTab — the settings "Utilities" surface. Renders one of several vault
 * analysis panels selected by the `activeUtility` prop: vault statistics,
 * password health, duplicate finder, consolidation wizard, bulk tag manager, and
 * breach check. Each panel runs its own Tauri command on demand and tracks its
 * own idle/loading/done/error state.
 */
import { useState, useCallback } from "react";
import { errorMessage } from "@/lib/error-message";
import * as cmd from "@/lib/commands";
import { usePagesStore } from "@/stores/pages-store";
import { SpinnerIcon } from "@/components/ui/icons";
import { ConsolidateDialog } from "./ConsolidateDialog";
import type {
  VaultStats,
  PasswordHealthReport,
  DuplicateReport,
  BreachCheckReport,
  TagUsage,
} from "@/lib/commands";

type UtilityState<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; data: T }
  | { status: "error"; error: string };

/** Identifies which utility panel is currently shown. */
export type UtilityId =
  | "stats"
  | "health"
  | "duplicates"
  | "consolidate"
  | "tags"
  | "breach";

/** Human-readable byte size (B / KB / MB). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Text color for a 0–4 password strength score (red → emerald). */
function scoreColor(score: number): string {
  switch (score) {
    case 0:
      return "text-red-500";
    case 1:
      return "text-orange-500";
    case 2:
      return "text-yellow-500";
    case 3:
      return "text-green-500";
    case 4:
      return "text-emerald-500";
    default:
      return "text-text-muted";
  }
}

/** Background color for a 0–4 password strength score, used for meter bars. */
function scoreBg(score: number): string {
  switch (score) {
    case 0:
      return "bg-red-500";
    case 1:
      return "bg-orange-500";
    case 2:
      return "bg-yellow-500";
    case 3:
      return "bg-green-500";
    case 4:
      return "bg-emerald-500";
    default:
      return "bg-text-muted";
  }
}

const SCORE_LABELS: Record<number, string> = {
  0: "Very Weak",
  1: "Weak",
  2: "Fair",
  3: "Strong",
  4: "Very Strong",
};

/** Accent button that shows a spinner while its analysis is running. */
function RunButton({
  loading,
  onClick,
  label,
}: {
  loading: boolean;
  onClick: () => void;
  label?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className="btn-accent rounded-lg px-4 py-2 text-[13px] font-medium disabled:opacity-50"
    >
      {loading ? (
        <span className="inline-flex items-center gap-2">
          <SpinnerIcon size={14} className="animate-spin" />
          Scanning...
        </span>
      ) : (
        (label ?? "Run Analysis")
      )}
    </button>
  );
}

/** Inline red error banner shown when an analysis fails. */
function ErrorMsg({ error }: { error: string }) {
  return (
    <p className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">
      {error}
    </p>
  );
}

/** A single label/value row used inside the result cards. */
function StatRow({
  label,
  value,
  color,
}: {
  label: string;
  value: string | number;
  color?: string;
}) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-[13px] text-text-muted">{label}</span>
      <span className={`text-[13px] font-medium ${color ?? "text-text-primary"}`}>
        {value}
      </span>
    </div>
  );
}

// ── Individual Utility Panels ──

/** Vault statistics panel: page/folder/secret/tag counts, size, and top tags. */
function StatsPanel({
  state,
  onRun,
}: {
  state: UtilityState<VaultStats>;
  onRun: () => void;
}) {
  return (
    <div>
      <h2 className="text-lg font-semibold text-text-primary">Vault Statistics</h2>
      <p className="mt-1 text-[13px] text-text-muted">
        Overview of pages, folders, secrets, and tags in your vault.
      </p>
      <div className="mt-4">
        <RunButton loading={state.status === "loading"} onClick={onRun} />
      </div>
      {state.status === "error" && <ErrorMsg error={state.error} />}
      {state.status === "done" && (
        <div className="mt-4 rounded-xl border border-border/60 bg-surface p-4">
          <div className="divide-y divide-border/40">
            <StatRow label="Pages" value={state.data.total_pages} />
            <StatRow label="Folders" value={state.data.total_folders} />
            <StatRow label="Secrets" value={state.data.total_secrets} />
            <StatRow label="Tags" value={state.data.total_tags} />
            <StatRow
              label="Vault Size"
              value={formatBytes(state.data.total_size_bytes)}
            />
            <StatRow
              label="Avg Secrets/Page"
              value={state.data.avg_secrets_per_page.toFixed(1)}
            />
          </div>
          {state.data.top_tags.length > 0 && (
            <div className="mt-4 border-t border-border/40 pt-3">
              <span className="text-[12px] font-medium text-text-muted">Top Tags</span>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {state.data.top_tags.slice(0, 12).map(([tag, count]) => (
                  <span
                    key={tag}
                    className="rounded-full bg-accent/10 px-2.5 py-1 text-[11px] font-medium text-accent"
                  >
                    {tag} ({count})
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Password health panel: strength distribution bars, reuse count, and entries. */
function HealthPanel({
  state,
  onRun,
}: {
  state: UtilityState<PasswordHealthReport>;
  onRun: () => void;
}) {
  return (
    <div>
      <h2 className="text-lg font-semibold text-text-primary">Password Health</h2>
      <p className="mt-1 text-[13px] text-text-muted">
        Analyze strength and detect reuse across all stored passwords.
      </p>
      <div className="mt-4">
        <RunButton loading={state.status === "loading"} onClick={onRun} />
      </div>
      {state.status === "error" && <ErrorMsg error={state.error} />}
      {state.status === "done" && (
        <div className="mt-4 space-y-4">
          {/* Summary */}
          <div className="rounded-xl border border-border/60 bg-surface p-4">
            <div className="divide-y divide-border/40">
              <StatRow label="Total Passwords" value={state.data.summary.total} />
              {state.data.summary.reused_count > 0 && (
                <StatRow
                  label="Reused"
                  value={state.data.summary.reused_count}
                  color="text-orange-500"
                />
              )}
            </div>
            {/* Score bars */}
            <div className="mt-4 space-y-2">
              {[4, 3, 2, 1, 0].map((score) => {
                const count = state.data.summary.by_score[score] ?? 0;
                if (count === 0) return null;
                const pct = Math.max(4, (count / state.data.summary.total) * 100);
                return (
                  <div key={score} className="flex items-center gap-3">
                    <span className={`w-20 text-[12px] font-medium ${scoreColor(score)}`}>
                      {SCORE_LABELS[score]}
                    </span>
                    <div className="h-3 flex-1 overflow-hidden rounded-full bg-surface-overlay">
                      <div
                        className={`h-full rounded-full ${scoreBg(score)}`}
                        style={{ width: `${pct}%`, opacity: 0.8 }}
                      />
                    </div>
                    <span className="w-8 text-right text-[12px] font-medium text-text-muted">
                      {count}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
          {/* Entries */}
          {state.data.entries.length > 0 && (
            <div className="rounded-xl border border-border/60 bg-surface">
              <div className="border-b border-border/40 px-4 py-2">
                <span className="text-[12px] font-medium text-text-muted">
                  All Entries ({state.data.entries.length})
                </span>
              </div>
              <div className="max-h-64 overflow-auto">
                {state.data.entries.map((e, i) => (
                  <div
                    key={i}
                    className={`border-b border-border/20 px-4 py-2 last:border-0 ${e.reused ? "bg-orange-500/5" : ""}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-[12px] text-text-primary">
                        {e.label}
                      </span>
                      <span
                        className={`shrink-0 text-[11px] font-semibold ${scoreColor(e.score)}`}
                      >
                        {e.label_text}
                      </span>
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px]">
                      <span className="truncate text-text-muted">{e.page_title}</span>
                      {e.reused && (
                        <span className="rounded bg-orange-500/15 px-1.5 py-0.5 text-[10px] font-medium text-orange-500">
                          reused
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Duplicate finder panel: groups of credentials that share labels/usernames/URLs. */
function DuplicatesPanel({
  state,
  onRun,
}: {
  state: UtilityState<DuplicateReport>;
  onRun: () => void;
}) {
  return (
    <div>
      <h2 className="text-lg font-semibold text-text-primary">Duplicate Finder</h2>
      <p className="mt-1 text-[13px] text-text-muted">
        Find duplicate credentials by comparing labels, usernames, and URLs.
      </p>
      <div className="mt-4">
        <RunButton loading={state.status === "loading"} onClick={onRun} />
      </div>
      {state.status === "error" && <ErrorMsg error={state.error} />}
      {state.status === "done" && (
        <div className="mt-4">
          {state.data.groups.length === 0 ? (
            <div className="rounded-xl border border-green-500/30 bg-green-500/5 px-4 py-3 text-[13px] text-green-600">
              No duplicates found. Your vault is clean.
            </div>
          ) : (
            <div className="space-y-3">
              <div className="rounded-lg bg-orange-500/10 px-3 py-2 text-[12px] font-medium text-orange-500">
                {state.data.groups.length} duplicate group
                {state.data.groups.length > 1 ? "s" : ""} found
              </div>
              {state.data.groups.map((group, i) => (
                <div key={i} className="rounded-xl border border-border/60 bg-surface">
                  <div className="border-b border-border/40 px-4 py-2">
                    <span className="text-[13px] font-semibold text-text-primary">
                      {group.key}
                    </span>
                  </div>
                  <div className="divide-y divide-border/20">
                    {group.entries.map((e, j) => (
                      <div key={j} className="px-4 py-2 text-[12px]">
                        <div className="truncate text-text-primary">{e.label}</div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px]">
                          <span className="truncate text-text-muted">
                            in {e.page_title}
                          </span>
                          {e.username && (
                            <span className="truncate rounded bg-accent/10 px-1.5 py-0.5 text-accent">
                              {e.username}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Entry point panel that explains and launches the consolidation wizard dialog. */
function ConsolidatePanel({ onOpen }: { onOpen: () => void }) {
  return (
    <div>
      <h2 className="text-lg font-semibold text-text-primary">Consolidate Passwords</h2>
      <p className="mt-1 text-[13px] text-text-muted">
        Group credentials by domain, merging all content (secrets, text, media) from
        source pages into consolidated pages. Source pages and folders are cleaned up
        after consolidation.
      </p>
      <div className="mt-4">
        <button
          onClick={onOpen}
          className="btn-accent rounded-lg px-4 py-2 text-[13px] font-medium"
        >
          Open Consolidation Wizard
        </button>
      </div>
      <div className="mt-4 rounded-xl border border-border/60 bg-surface p-4">
        <h3 className="text-[13px] font-medium text-text-primary">How it works</h3>
        <ol className="mt-2 list-inside list-decimal space-y-1.5 text-[12px] text-text-muted">
          <li>Select a source folder containing imported credentials</li>
          <li>Choose a target folder for the consolidated pages</li>
          <li>Preview the grouping — pages are grouped by domain</li>
          <li>
            Execute — secrets, text, and media are merged into single pages per domain
          </li>
          <li>Source pages and empty folders are cleaned up automatically</li>
        </ol>
      </div>
    </div>
  );
}

/** Bulk tag manager panel: lists tag usage and supports rename/delete operations. */
function TagsPanel({
  state,
  onRun,
  tagRenameFrom,
  setTagRenameFrom,
  tagRenameTo,
  setTagRenameTo,
  onRename,
  onDelete,
  tagOpLoading,
}: {
  state: UtilityState<TagUsage[]>;
  onRun: () => void;
  tagRenameFrom: string;
  setTagRenameFrom: (v: string) => void;
  tagRenameTo: string;
  setTagRenameTo: (v: string) => void;
  onRename: () => void;
  onDelete: (tag: string) => void;
  tagOpLoading: boolean;
}) {
  return (
    <div>
      <h2 className="text-lg font-semibold text-text-primary">Bulk Tag Manager</h2>
      <p className="mt-1 text-[13px] text-text-muted">
        View tag usage, rename, delete, or merge tags across all pages.
      </p>
      <div className="mt-4">
        <RunButton
          loading={state.status === "loading"}
          onClick={onRun}
          label="Load Tags"
        />
      </div>
      {state.status === "error" && <ErrorMsg error={state.error} />}
      {state.status === "done" && (
        <div className="mt-4 space-y-4">
          {/* Tag list */}
          <div className="rounded-xl border border-border/60 bg-surface">
            <div className="border-b border-border/40 px-4 py-2">
              <span className="text-[12px] font-medium text-text-muted">
                Tags ({state.data.length})
              </span>
            </div>
            <div className="max-h-64 divide-y divide-border/20 overflow-auto">
              {state.data.map((t) => (
                <div
                  key={t.tag}
                  className="flex items-center justify-between gap-2 px-4 py-2 hover:bg-surface-overlay/40"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-[13px] text-text-primary">
                      {t.tag}
                    </span>
                    <span className="shrink-0 text-[11px] text-text-muted">
                      {t.count} page{t.count !== 1 ? "s" : ""}
                    </span>
                  </div>
                  <button
                    onClick={() => onDelete(t.tag)}
                    disabled={tagOpLoading}
                    className="rounded-md px-2 py-1 text-[11px] text-danger transition-colors hover:bg-danger/10 disabled:opacity-50"
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>
          </div>
          {/* Rename */}
          <div className="rounded-xl border border-border/60 bg-surface p-4">
            <h3 className="text-[13px] font-medium text-text-primary">Rename Tag</h3>
            <div className="mt-3 flex items-center gap-2">
              <input
                type="text"
                value={tagRenameFrom}
                onChange={(e) => setTagRenameFrom(e.target.value)}
                placeholder="From"
                className="focus-accent w-32 rounded-lg border border-border/60 bg-surface-raised px-3 py-1.5 text-[12px] text-text-primary outline-none"
              />
              <span className="text-text-muted">&rarr;</span>
              <input
                type="text"
                value={tagRenameTo}
                onChange={(e) => setTagRenameTo(e.target.value)}
                placeholder="To"
                className="focus-accent w-32 rounded-lg border border-border/60 bg-surface-raised px-3 py-1.5 text-[12px] text-text-primary outline-none"
              />
              <button
                onClick={onRename}
                disabled={tagOpLoading || !tagRenameFrom.trim() || !tagRenameTo.trim()}
                className="rounded-lg border border-border/60 px-3 py-1.5 text-[12px] font-medium text-text-secondary transition-all hover:bg-surface-overlay disabled:opacity-50"
              >
                Rename
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Breach check panel: k-anonymity lookup of passwords against known breaches. */
function BreachPanel({
  state,
  onRun,
}: {
  state: UtilityState<BreachCheckReport>;
  onRun: () => void;
}) {
  return (
    <div>
      <h2 className="text-lg font-semibold text-text-primary">Breach Check</h2>
      <p className="mt-1 text-[13px] text-text-muted">
        Check passwords against known data breaches using k-anonymity (privacy-safe — your
        passwords never leave your device).
      </p>
      <div className="mt-4">
        <RunButton
          loading={state.status === "loading"}
          onClick={onRun}
          label="Check Breaches"
        />
      </div>
      {state.status === "error" && <ErrorMsg error={state.error} />}
      {state.status === "done" && (
        <div className="mt-4 space-y-4">
          <div className="rounded-xl border border-border/60 bg-surface p-4">
            <div className="divide-y divide-border/40">
              <StatRow label="Checked" value={state.data.total_checked} />
              <StatRow
                label={state.data.total_breached > 0 ? "Breached" : "No breaches found"}
                value={state.data.total_breached}
                color={state.data.total_breached > 0 ? "text-red-500" : "text-green-500"}
              />
            </div>
          </div>
          {state.data.entries.length > 0 && (
            <div className="rounded-xl border border-red-500/30 bg-surface">
              <div className="border-b border-red-500/20 px-4 py-2">
                <span className="text-[12px] font-medium text-red-500">
                  Breached Passwords
                </span>
              </div>
              <div className="max-h-64 divide-y divide-border/20 overflow-auto">
                {state.data.entries.map((e, i) => (
                  <div key={i} className="px-4 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-[13px] font-medium text-text-primary">
                        {e.label}
                      </span>
                      <span className="shrink-0 rounded-md bg-red-500/10 px-2 py-0.5 text-[11px] font-semibold text-red-500">
                        {e.breach_count.toLocaleString()}x exposed
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-text-muted">
                      {e.page_title}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main Component ──

/** Owns per-utility run state and renders the panel matching `activeUtility`. */
export function UtilitiesTab({ activeUtility }: { activeUtility: UtilityId }) {
  const { loadPages } = usePagesStore();
  const [stats, setStats] = useState<UtilityState<VaultStats>>({ status: "idle" });
  const [health, setHealth] = useState<UtilityState<PasswordHealthReport>>({
    status: "idle",
  });
  const [duplicates, setDuplicates] = useState<UtilityState<DuplicateReport>>({
    status: "idle",
  });
  const [consolidateOpen, setConsolidateOpen] = useState(false);
  const [tags, setTags] = useState<UtilityState<TagUsage[]>>({ status: "idle" });
  const [breach, setBreach] = useState<UtilityState<BreachCheckReport>>({
    status: "idle",
  });

  const [tagRenameFrom, setTagRenameFrom] = useState("");
  const [tagRenameTo, setTagRenameTo] = useState("");
  const [tagOpLoading, setTagOpLoading] = useState(false);

  const runStats = useCallback(async () => {
    setStats({ status: "loading" });
    try {
      setStats({ status: "done", data: await cmd.utilityVaultStats() });
    } catch (e) {
      setStats({ status: "error", error: errorMessage(e) });
    }
  }, []);

  const runHealth = useCallback(async () => {
    setHealth({ status: "loading" });
    try {
      setHealth({ status: "done", data: await cmd.utilityPasswordHealth() });
    } catch (e) {
      setHealth({ status: "error", error: errorMessage(e) });
    }
  }, []);

  const runDuplicates = useCallback(async () => {
    setDuplicates({ status: "loading" });
    try {
      setDuplicates({ status: "done", data: await cmd.utilityFindDuplicates() });
    } catch (e) {
      setDuplicates({ status: "error", error: errorMessage(e) });
    }
  }, []);

  const runTags = useCallback(async () => {
    setTags({ status: "loading" });
    try {
      setTags({ status: "done", data: await cmd.utilityListTagsUsage() });
    } catch (e) {
      setTags({ status: "error", error: errorMessage(e) });
    }
  }, []);

  const runBreach = useCallback(async () => {
    setBreach({ status: "loading" });
    try {
      setBreach({ status: "done", data: await cmd.utilityBreachCheck() });
    } catch (e) {
      setBreach({ status: "error", error: errorMessage(e) });
    }
  }, []);

  const handleTagRename = useCallback(async () => {
    if (!tagRenameFrom.trim() || !tagRenameTo.trim()) return;
    setTagOpLoading(true);
    try {
      await cmd.utilityBulkTagOperation({
        type: "rename",
        from: tagRenameFrom,
        to: tagRenameTo,
      });
      setTagRenameFrom("");
      setTagRenameTo("");
      setTags({ status: "done", data: await cmd.utilityListTagsUsage() });
      loadPages();
    } catch (e) {
      setTags({ status: "error", error: errorMessage(e) });
    }
    setTagOpLoading(false);
  }, [tagRenameFrom, tagRenameTo, loadPages]);

  const handleTagDelete = useCallback(
    async (tag: string) => {
      setTagOpLoading(true);
      try {
        await cmd.utilityBulkTagOperation({ type: "delete", tag });
        setTags({ status: "done", data: await cmd.utilityListTagsUsage() });
        loadPages();
      } catch (e) {
        setTags({ status: "error", error: errorMessage(e) });
      }
      setTagOpLoading(false);
    },
    [loadPages],
  );

  return (
    <>
      {activeUtility === "stats" && <StatsPanel state={stats} onRun={runStats} />}
      {activeUtility === "health" && <HealthPanel state={health} onRun={runHealth} />}
      {activeUtility === "duplicates" && (
        <DuplicatesPanel state={duplicates} onRun={runDuplicates} />
      )}
      {activeUtility === "consolidate" && (
        <ConsolidatePanel onOpen={() => setConsolidateOpen(true)} />
      )}
      {activeUtility === "tags" && (
        <TagsPanel
          state={tags}
          onRun={runTags}
          tagRenameFrom={tagRenameFrom}
          setTagRenameFrom={setTagRenameFrom}
          tagRenameTo={tagRenameTo}
          setTagRenameTo={setTagRenameTo}
          onRename={handleTagRename}
          onDelete={handleTagDelete}
          tagOpLoading={tagOpLoading}
        />
      )}
      {activeUtility === "breach" && <BreachPanel state={breach} onRun={runBreach} />}
      {consolidateOpen && <ConsolidateDialog onClose={() => setConsolidateOpen(false)} />}
    </>
  );
}
