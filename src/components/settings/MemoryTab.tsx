// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * MemoryTab — the Agent Memory dashboard in Settings. One table per
 * namespace showing each memory page's kind, who last wrote it, whether the
 * owner has reviewed it, whether it is stale, and how often agents read it.
 * The owner can mark pages reviewed here without opening them, or open one
 * in the editor.
 */
import { useCallback, useEffect, useState } from "react";
import * as cmd from "@/lib/commands";
import { errorMessage } from "@/lib/error-message";
import { formatDate } from "@/lib/format-date";
import { usePagesStore } from "@/stores/pages-store";
import { useUIStore } from "@/stores/ui-store";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { SpinnerIcon } from "@/components/ui/icons";

function Stat({ label, value, tone }: { label: string; value: number; tone?: "warn" }) {
  return (
    <div className="rounded-lg border border-border/60 px-3 py-2">
      <p
        className={`text-[16px] font-semibold ${tone === "warn" && value > 0 ? "text-warning" : "text-text-primary"}`}
      >
        {value.toLocaleString()}
      </p>
      <p className="text-[10px] text-text-muted/70">{label}</p>
    </div>
  );
}

export function MemoryTab() {
  const [namespaces, setNamespaces] = useState<cmd.NamespaceOverview[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unreviewedOnly, setUnreviewedOnly] = useState(false);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const setMemoryReviewed = usePagesStore((s) => s.setMemoryReviewed);
  const openPage = usePagesStore((s) => s.openPage);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setNamespaces(await cmd.memoryOverview());
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
    setLoading(false);
  }, []);

  // The async work is wrapped so the effect body itself performs no
  // synchronous state update (the lint rule that keeps renders from cascading).
  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const review = useCallback(
    async (path: string, reviewed: boolean) => {
      setBusyPath(path);
      await setMemoryReviewed(path, reviewed);
      await load();
      setBusyPath(null);
    },
    [setMemoryReviewed, load],
  );

  const open = useCallback(
    async (path: string) => {
      setSettingsOpen(false);
      await openPage(path);
    },
    [openPage, setSettingsOpen],
  );

  const pages = namespaces.flatMap((n) => n.pages);
  const unreviewed = pages.filter((p) => !p.reviewed).length;
  const stale = pages.filter((p) => p.stale).length;

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="text-[13px] leading-relaxed text-text-secondary">
          What your AI agents remember, by project. Pages an agent wrote stay marked
          unreviewed until you have read them; agents see that mark when they read the
          page back.
        </p>
        <p className="text-[10px] text-text-dim">
          Stored in this vault under ai/memory. Nothing here leaves the device.
        </p>
      </div>

      {error && (
        <p className="rounded-md bg-danger/10 px-2 py-1 text-[11px] text-danger">
          {error}
        </p>
      )}

      <div className="grid grid-cols-4 gap-2">
        <Stat label="Namespaces" value={namespaces.length} />
        <Stat label="Pages" value={pages.length} />
        <Stat label="Unreviewed" value={unreviewed} tone="warn" />
        <Stat label="Stale" value={stale} tone="warn" />
      </div>

      <label className="flex items-center gap-2 text-[11px] text-text-secondary">
        <input
          type="checkbox"
          checked={unreviewedOnly}
          onChange={(e) => setUnreviewedOnly(e.target.checked)}
        />
        Show only pages waiting for review
      </label>

      {loading ? (
        <div className="flex items-center gap-2 py-6 text-[11px] text-text-muted">
          <SpinnerIcon size={12} /> Loading memory
        </div>
      ) : pages.length === 0 ? (
        <p className="py-6 text-center text-[11px] text-text-muted/60">
          No agent memory yet. An agent creates it with bootstrap_project.
        </p>
      ) : (
        namespaces.map((ns) => {
          const rows = unreviewedOnly ? ns.pages.filter((p) => !p.reviewed) : ns.pages;
          if (rows.length === 0) return null;
          return (
            <div key={ns.namespace}>
              <SectionHeader title={ns.namespace} />
              <div className="overflow-x-auto">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="text-left text-[10px] uppercase tracking-wider text-text-muted/60">
                      <th className="py-1 pr-2 font-medium">Page</th>
                      <th className="py-1 pr-2 font-medium">Kind</th>
                      <th className="py-1 pr-2 font-medium">Last written by</th>
                      <th className="py-1 pr-2 font-medium">Reads</th>
                      <th className="py-1 pr-2 font-medium">State</th>
                      <th className="py-1 font-medium" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((p) => (
                      <tr key={p.path} className="border-t border-border/40">
                        <td className="py-1.5 pr-2">
                          <button
                            onClick={() => void open(p.path)}
                            className="text-left font-medium text-text-primary hover:text-accent"
                            title={`Updated ${formatDate(p.updated_at)}`}
                          >
                            {p.title}
                          </button>
                        </td>
                        <td className="py-1.5 pr-2 text-text-secondary">
                          {p.kind ?? "–"}
                        </td>
                        <td className="py-1.5 pr-2 text-text-secondary">
                          {p.written_by_name ?? "You"}
                        </td>
                        <td
                          className="py-1.5 pr-2 text-text-secondary"
                          title={
                            p.last_read
                              ? `Last read ${formatDate(p.last_read)}`
                              : "Never read"
                          }
                        >
                          {p.read_count}
                        </td>
                        <td className="py-1.5 pr-2">
                          <span className="flex flex-wrap gap-1">
                            {!p.reviewed && (
                              <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[10px] text-warning">
                                unreviewed
                              </span>
                            )}
                            {p.stale && (
                              <span
                                className="rounded bg-border/60 px-1.5 py-0.5 text-[10px] text-text-muted"
                                title={
                                  p.superseded_by
                                    ? `Superseded by ${p.superseded_by}`
                                    : p.valid_until
                                      ? `Valid until ${formatDate(p.valid_until)}`
                                      : "Stale"
                                }
                              >
                                stale
                              </span>
                            )}
                            {p.verified_on && (
                              <span
                                className="rounded bg-success/15 px-1.5 py-0.5 text-[10px] text-success"
                                title={`Verified ${formatDate(p.verified_on)}`}
                              >
                                verified
                              </span>
                            )}
                          </span>
                        </td>
                        <td className="py-1.5 text-right">
                          <button
                            onClick={() => void review(p.path, !p.reviewed)}
                            disabled={busyPath === p.path}
                            className="rounded-md border border-border/60 px-2 py-0.5 text-[10px] text-text-primary transition-all hover:border-accent/40 hover:bg-accent/5 disabled:opacity-50"
                          >
                            {p.reviewed ? "Unreview" : "Mark reviewed"}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
