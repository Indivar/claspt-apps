// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * InspectorPanel — the right-hand details panel for the active page.
 *
 * Shows read-only metadata and word/character statistics, an editable tag list, a
 * whole-body encryption toggle, and the page's git version history with per-commit
 * diff viewing and restore. Word/char counts deliberately exclude secret blocks so
 * encrypted values are never counted.
 */
import { useCallback, useEffect, useState } from "react";
import { usePagesStore } from "@/stores/pages-store";
import { useUIStore } from "@/stores/ui-store";
import * as cmd from "@/lib/commands";
import { errorMessage } from "@/lib/error-message";
import { formatDate } from "@/lib/format-date";
import { needsReview } from "@/lib/memory-review";
import { CloseIcon, LockClosedIcon, LockOpenIcon } from "@/components/ui/icons";
import type { CommitEntry, Page } from "@claspt/shared/types";
import { CommitDiffModal } from "./CommitDiffModal";

function countWords(text: string): number {
  return text
    .replace(/:::secret\[.*?\][\s\S]*?:::/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
}

function countChars(text: string): number {
  return text.replace(/:::secret\[.*?\][\s\S]*?:::/g, "").length;
}

function MetadataRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-2 py-1">
      <span className="shrink-0 text-[11px] text-text-muted/70">{label}</span>
      <span className="text-right text-[11px] font-medium text-text-primary">
        {value}
      </span>
    </div>
  );
}

function SectionLabel({ title }: { title: string }) {
  return (
    <h4 className="mb-1.5 mt-4 border-b border-border/40 pb-1 text-[10px] font-semibold uppercase tracking-widest text-text-muted/60 first:mt-0">
      {title}
    </h4>
  );
}

function TagEditor({
  tags,
  pagePath,
  allTags,
}: {
  tags: string[];
  pagePath: string;
  allTags: string[];
}) {
  const { updateTags } = usePagesStore();
  const [input, setInput] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);

  const suggestions = allTags.filter(
    (t) => !tags.includes(t) && t.toLowerCase().includes(input.toLowerCase()),
  );

  const addTag = useCallback(
    (tag: string) => {
      const trimmed = tag.trim().toLowerCase();
      if (trimmed && !tags.includes(trimmed)) {
        updateTags(pagePath, [...tags, trimmed]);
      }
      setInput("");
      setShowSuggestions(false);
    },
    [tags, pagePath, updateTags],
  );

  const removeTag = useCallback(
    (tag: string) => {
      updateTags(
        pagePath,
        tags.filter((t) => t !== tag),
      );
    },
    [tags, pagePath, updateTags],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && input.trim()) {
        e.preventDefault();
        addTag(input);
      }
    },
    [input, addTag],
  );

  return (
    <div>
      <div className="flex flex-wrap gap-1 py-1">
        {tags.map((tag) => (
          <span
            key={tag}
            className="flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-xs text-accent"
          >
            {tag}
            <button
              onClick={() => removeTag(tag)}
              className="text-accent/60 hover:text-accent"
            >
              x
            </button>
          </span>
        ))}
      </div>
      <div className="relative mt-1">
        <input
          type="text"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setShowSuggestions(e.target.value.length > 0);
          }}
          onKeyDown={handleKeyDown}
          onFocus={() => setShowSuggestions(input.length > 0)}
          onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
          placeholder="Add tag..."
          className="focus-accent w-full rounded-md border border-border/60 bg-surface px-2 py-1.5 text-[11px] text-text-primary outline-none"
        />
        {showSuggestions && suggestions.length > 0 && (
          <div className="absolute left-0 top-full z-10 mt-1 w-full overflow-hidden rounded-lg border border-border/60 bg-surface shadow-lg">
            {suggestions.slice(0, 5).map((tag) => (
              <button
                key={tag}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => addTag(tag)}
                className="w-full px-2.5 py-1.5 text-left text-[11px] text-text-primary transition-colors hover:bg-accent/8 hover:text-accent"
              >
                {tag}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function InspectorPanel() {
  const { activePage } = usePagesStore();
  const { inspectorOpen } = useUIStore();

  if (!inspectorOpen || !activePage) return null;

  return <InspectorContent key={activePage.path} page={activePage} />;
}

/**
 * Review state of an agent-memory page. A client write marks the page
 * unreviewed and API reads return it inside data markers until the owner
 * confirms here that they have looked at it.
 */
function ReviewToggle({ page }: { page: Page }) {
  const { setMemoryReviewed } = usePagesStore();
  const [saving, setSaving] = useState(false);
  const { written_by_name } = page.meta;
  const unreviewed = needsReview(page.meta);

  const handleClick = useCallback(async () => {
    setSaving(true);
    await setMemoryReviewed(page.path, unreviewed);
    setSaving(false);
  }, [page.path, unreviewed, setMemoryReviewed]);

  return (
    <div className="py-1">
      <div className="rounded-lg border border-border/60 px-3 py-2.5">
        <p className="text-[11px] font-medium text-text-primary">
          {unreviewed ? "Not yet reviewed" : "Reviewed"}
        </p>
        <p className="mt-0.5 text-[10px] leading-relaxed text-text-muted/60">
          {written_by_name
            ? `Last written by ${written_by_name}. `
            : "Written in the app. "}
          {unreviewed
            ? "Agents reading this page get its content marked as unreviewed data."
            : "Agents read this page as trusted memory."}
        </p>
        <button
          onClick={handleClick}
          disabled={saving}
          className="mt-2 rounded-md border border-border/60 px-2 py-1 text-[10px] font-medium text-text-primary transition-all hover:border-accent/40 hover:bg-accent/5 disabled:opacity-50"
        >
          {unreviewed ? "Mark as reviewed" : "Mark as unreviewed"}
        </button>
      </div>
    </div>
  );
}

function EncryptionToggle({ page }: { page: Page }) {
  const { toggleEncryption } = usePagesStore();
  const [toggling, setToggling] = useState(false);

  const handleToggle = useCallback(async () => {
    setToggling(true);
    await toggleEncryption(page.path);
    setToggling(false);
  }, [page.path, toggleEncryption]);

  const isEncrypted = page.meta.encrypted;

  return (
    <div className="py-1">
      <button
        onClick={handleToggle}
        disabled={toggling}
        className="flex w-full items-center justify-between rounded-lg border border-border/60 px-3 py-2.5 transition-all hover:border-accent/40 hover:bg-accent/5 disabled:opacity-50"
      >
        <div className="flex items-center gap-2">
          {isEncrypted ? <LockClosedIcon size={14} /> : <LockOpenIcon size={14} />}
          <span className="text-[11px] font-medium text-text-primary">
            {isEncrypted ? "Entire body encrypted" : "Only secret blocks encrypted"}
          </span>
        </div>
        <div
          className={`flex h-5 w-9 items-center rounded-full transition-colors ${
            isEncrypted ? "bg-accent" : "bg-border"
          }`}
        >
          <div
            className={`h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${
              isEncrypted ? "translate-x-4" : "translate-x-0.5"
            }`}
          />
        </div>
      </button>
      {isEncrypted && (
        <p className="mt-1.5 text-[10px] leading-relaxed text-text-muted/60">
          Body content won&apos;t appear in search results
        </p>
      )}
      {toggling && (
        <p className="mt-1 text-[10px] text-accent">
          {isEncrypted ? "Decrypting..." : "Encrypting..."}
        </p>
      )}
    </div>
  );
}

function InspectorContent({ page }: { page: Page }) {
  const { activePage, openPage } = usePagesStore();
  const { setInspectorOpen } = useUIStore();
  const [history, setHistory] = useState<CommitEntry[]>([]);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [diffOid, setDiffOid] = useState<string | null>(null);
  const [restoringOid, setRestoringOid] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  // Fetch git history and all tags
  useEffect(() => {
    let cancelled = false;
    cmd.gitFileLog(page.path, 20).then(
      (entries) => {
        if (!cancelled) setHistory(entries);
      },
      () => {
        /* ignore errors */
      },
    );
    cmd.listTags().then(
      (tags) => {
        if (!cancelled) setAllTags(tags);
      },
      () => {
        /* ignore errors */
      },
    );
    return () => {
      cancelled = true;
    };
  }, [page.path]);

  // Use activePage for up-to-date tags after tag edits
  const currentPage = activePage?.path === page.path ? activePage : page;
  const { meta, content } = currentPage;
  const words = countWords(content);
  const chars = countChars(content);

  return (
    <div className="inspector-panel flex w-[260px] shrink-0 flex-col border-l border-border bg-surface-raised">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          Inspector
        </span>
        <button
          onClick={() => setInspectorOpen(false)}
          className="icon-btn p-1 text-text-muted"
        >
          <CloseIcon size={12} />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        <SectionLabel title="Metadata" />
        <MetadataRow label="Title" value={meta.title} />
        <MetadataRow label="Folder" value={meta.folder} />
        <MetadataRow label="Created" value={formatDate(meta.created_at)} />
        <MetadataRow label="Updated" value={formatDate(meta.updated_at)} />
        <MetadataRow label="ID" value={meta.id.slice(0, 8) + "..."} />
        <div data-tour="pin-archive">
          <MetadataRow label="Pinned" value={meta.pinned ? "Yes" : "No"} />
          <MetadataRow label="Archived" value={meta.archived ? "Yes" : "No"} />
        </div>

        <div data-tour="encrypt-page">
          <SectionLabel title="Encryption" />
          <EncryptionToggle page={currentPage} />
        </div>

        {meta.folder.startsWith("ai/memory") && (
          <div>
            <SectionLabel title="Agent review" />
            <ReviewToggle page={currentPage} />
          </div>
        )}

        <div data-tour="tags">
          <SectionLabel title="Tags" />
          <TagEditor
            tags={meta.tags ?? []}
            pagePath={currentPage.path}
            allTags={allTags}
          />
        </div>

        <SectionLabel title="Statistics" />
        <MetadataRow label="Words" value={words.toLocaleString()} />
        <MetadataRow label="Characters" value={chars.toLocaleString()} />

        <div data-tour="git-history">
          <SectionLabel title="Version History" />
          {history.length === 0 ? (
            <p className="py-3 text-center text-[11px] text-text-muted/60">
              No commits yet
            </p>
          ) : (
            <div className="space-y-1.5 py-1">
              {restoreError && (
                <p className="rounded-md bg-danger/10 px-2 py-1 text-[10px] text-danger">
                  {restoreError}
                </p>
              )}
              {history.map((entry, idx) => (
                <div
                  key={entry.oid}
                  className="commit-card rounded-lg border border-border/60 px-2.5 py-2 transition-all hover:border-accent/40 hover:bg-accent/5"
                >
                  <button
                    onClick={() => setDiffOid(entry.oid)}
                    className="w-full text-left"
                  >
                    <p className="text-[11px] leading-relaxed text-text-primary">
                      {entry.message}
                    </p>
                    <p className="mt-1 text-[10px] text-text-muted/60">
                      {formatDate(entry.timestamp)}
                    </p>
                  </button>
                  {/* Show restore button on all but the latest (current) version */}
                  {idx > 0 && (
                    <button
                      onClick={async () => {
                        setRestoringOid(entry.oid);
                        setRestoreError(null);
                        try {
                          await cmd.gitRestoreToCommit(entry.oid, page.path);
                          await openPage(page.path);
                          // Refresh history
                          const entries = await cmd.gitFileLog(page.path, 20);
                          setHistory(entries);
                        } catch (e) {
                          setRestoreError(errorMessage(e));
                        }
                        setRestoringOid(null);
                      }}
                      disabled={restoringOid !== null}
                      className="mt-1.5 rounded px-2 py-0.5 text-[10px] font-medium text-accent transition-colors hover:bg-accent/10 disabled:opacity-50"
                    >
                      {restoringOid === entry.oid ? "Restoring..." : "Restore"}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {diffOid && (
        <CommitDiffModal
          oid={diffOid}
          filePath={page.path}
          onClose={() => setDiffOid(null)}
          onRestore={async () => {
            // Reload page and refresh history after restore from diff modal
            await openPage(page.path);
            const entries = await cmd.gitFileLog(page.path, 20);
            setHistory(entries);
          }}
        />
      )}
    </div>
  );
}
