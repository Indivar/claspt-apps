// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * GeneratedHistoryTab — every password Claspt has generated, newest first.
 *
 * The list is read from the vault (see `@/lib/generated-history`), so it
 * survives a lock, a restart and a reinstall, and shows generations made in the
 * browser extension alongside the ones made here.
 *
 * Nothing expires on its own. Removal is a deliberate action: "Clear unused
 * passwords" takes only entries that were never copied or inserted and are
 * older than the stated age, so a password that is in service somewhere is
 * never swept away, and neither is one generated moments ago.
 */
import { useCallback, useEffect, useState } from "react";
import { formatTimeAgo } from "@claspt/shared/format-time";
import { unusedEntriesOlderThan, type StoredGeneratedEntry } from "@claspt/shared";
import { listGeneratedHistory, clearUnusedGenerated } from "@/lib/generated-history";
import { copyToClipboard, clearClipboardAfter } from "@/lib/clipboard";
import { errorMessage } from "@/lib/error-message";

/** Unused entries younger than this are never swept, so today's work is safe. */
const CLEAR_UNUSED_OLDER_THAN_DAYS = 30;

export function GeneratedHistoryTab() {
  const [entries, setEntries] = useState<StoredGeneratedEntry[]>([]);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [copiedLabel, setCopiedLabel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Bumped to re-read the list. Loading happens inside the effect with a
  // cancelled flag rather than through a callback, matching how the rest of the
  // app loads async data and keeping setState out of the effect body.
  const [reloadToken, setReloadToken] = useState(0);
  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    listGeneratedHistory()
      .then((list) => {
        if (cancelled) return;
        setEntries(list);
        setError(null);
      })
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const clearable = unusedEntriesOlderThan(entries, CLEAR_UNUSED_OLDER_THAN_DAYS);

  const handleClear = useCallback(async () => {
    setBusy(true);
    try {
      await clearUnusedGenerated(CLEAR_UNUSED_OLDER_THAN_DAYS);
      reload();
    } catch (e) {
      setError(errorMessage(e));
    }
    setBusy(false);
  }, [reload]);

  const handleCopy = useCallback(async (entry: StoredGeneratedEntry) => {
    const ok = await copyToClipboard(entry.password);
    if (!ok) return;
    setCopiedLabel(entry.label);
    clearClipboardAfter(30_000);
    setTimeout(() => setCopiedLabel(null), 2000);
  }, []);

  const toggle = useCallback((label: string) => {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }, []);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[13px] text-text-secondary">
          {entries.length} generated password{entries.length === 1 ? "" : "s"}
        </span>
        <button
          onClick={handleClear}
          disabled={busy || clearable.length === 0}
          className="rounded-lg border border-border/60 px-3 py-1 text-[12px] text-text-secondary transition-all hover:border-danger/40 hover:text-danger disabled:opacity-40 disabled:hover:border-border/60 disabled:hover:text-text-secondary"
        >
          {busy
            ? "Clearing..."
            : clearable.length === 0
              ? "Nothing unused to clear"
              : `Clear ${clearable.length} unused, over ${CLEAR_UNUSED_OLDER_THAN_DAYS} days old`}
        </button>
      </div>

      <p className="text-[11px] leading-relaxed text-text-muted">
        Saved in your vault, encrypted, and synced with your other devices. Nothing is
        removed on its own, and passwords you copied or inserted are never cleared by this
        button.
      </p>

      {error && <p className="text-[12px] text-danger">{error}</p>}

      {entries.length === 0 ? (
        <p className="py-8 text-center text-[13px] text-text-muted">
          Nothing yet. Every password you generate is kept here.
        </p>
      ) : (
        <div className="space-y-1.5">
          {entries.map((entry) => {
            const isRevealed = revealed.has(entry.label);
            const masked =
              entry.password.length > 4
                ? "•".repeat(8) + entry.password.slice(-2)
                : "•".repeat(4);
            return (
              <div
                key={`${entry.pagePath}::${entry.label}`}
                className="rounded-lg border border-border/60 bg-surface-raised px-3 py-2"
              >
                <div className="flex items-center gap-2">
                  <code className="flex-1 break-all font-mono text-[12px] text-text-primary select-all">
                    {isRevealed ? entry.password : masked}
                  </code>
                  <button
                    onClick={() => toggle(entry.label)}
                    className="rounded px-2 py-0.5 text-[11px] text-text-muted transition-colors hover:text-accent"
                  >
                    {isRevealed ? "Hide" : "Show"}
                  </button>
                  <button
                    onClick={() => void handleCopy(entry)}
                    className="rounded border border-border/60 px-2 py-0.5 text-[11px] text-text-secondary transition-colors hover:text-accent"
                  >
                    {copiedLabel === entry.label ? "Copied" : "Copy"}
                  </button>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-text-muted">
                  <span className={entry.used ? "text-accent" : ""}>
                    {entry.used ? "used" : "not used"}
                  </span>
                  <span>· {entry.source}</span>
                  {entry.site && <span>· {entry.site}</span>}
                  <span className="ml-auto">{formatTimeAgo(entry.generated)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
