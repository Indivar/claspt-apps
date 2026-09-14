// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * SearchPanel — the full-text search command palette (Mod+K).
 *
 * A modal overlay with a debounced query input backed by the tantivy search
 * index (via the search store). Results are keyboard-navigable (arrow keys +
 * Enter) and hover-selectable; the selected result is previewed (secret-safe,
 * masked) in a side pane. Right-clicking a result offers a confirm-guarded
 * delete (routed to the OS trash) so search doubles as a cleanup tool.
 * Scrolling the results list near the bottom loads the next page.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { usePagesStore } from "@/stores/pages-store";
import { useSearchStore } from "@/stores/search-store";
import { SpinnerIcon } from "@/components/ui/icons";
import * as cmd from "@/lib/commands";
import { maskSecretBlocks } from "@/lib/extensions/preview-pipeline";
import type { SearchResult, SearchScope } from "@claspt/shared/types";

const FOLDER_PREFIX = "folder:";

/** Encode a SearchScope as a flat `<select>` value. */
function scopeToValue(scope: SearchScope): string {
  if (scope === "all" || scope === "secrets_only") return scope;
  return `${FOLDER_PREFIX}${scope.folder}`;
}

/** Decode a `<select>` value back into a SearchScope. */
function valueToScope(value: string): SearchScope {
  if (value === "secrets_only") return "secrets_only";
  if (value.startsWith(FOLDER_PREFIX)) {
    return { folder: value.slice(FOLDER_PREFIX.length) };
  }
  return "all";
}

type PreviewState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "encrypted" }
  | { kind: "ready"; text: string };

/**
 * Secret-safe peek of a page's content for the preview pane. Keyed by path so
 * each selection remounts with fresh state (no setState-in-effect reset). Never
 * shows secret values: `:::secret` blocks are masked to their labels and
 * full-body-encrypted pages show a locked placeholder rather than plaintext.
 */
function SearchPreview({ result }: { result: SearchResult }) {
  const [state, setState] = useState<PreviewState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      cmd
        .readPage(result.path)
        .then((page) => {
          if (cancelled) return;
          if (page.meta.encrypted) {
            setState({ kind: "encrypted" });
          } else {
            setState({ kind: "ready", text: maskSecretBlocks(page.content) });
          }
        })
        .catch(() => {
          if (!cancelled) setState({ kind: "error" });
        });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [result.path]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border/40 px-4 py-2.5">
        <div className="truncate text-sm font-semibold text-text-primary">
          {result.title}
        </div>
        <div className="mt-0.5 truncate text-[11px] text-text-muted">{result.folder}</div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {state.kind === "loading" && (
          <p className="text-[12px] text-text-muted/70">Loading preview…</p>
        )}
        {state.kind === "error" && (
          <p className="text-[12px] text-text-muted">Couldn't load preview.</p>
        )}
        {state.kind === "encrypted" && (
          <p className="text-[12px] text-text-muted">
            🔒 This page is encrypted — open it to view its contents.
          </p>
        )}
        {state.kind === "ready" &&
          (state.text.trim() === "" ? (
            <p className="text-[12px] text-text-muted/70">This page is empty.</p>
          ) : (
            <pre className="whitespace-pre-wrap break-words font-sans text-[12px] leading-relaxed text-text-primary/90">
              {state.text}
            </pre>
          ))}
      </div>
    </div>
  );
}

interface ResultMenu {
  x: number;
  y: number;
  index: number;
}

/** Modal search palette. Renders nothing unless the search store is open. */
export function SearchPanel() {
  const {
    query,
    results,
    isOpen,
    loading,
    selectedIndex,
    setQuery,
    search,
    close,
    setSelectedIndex,
    setSearchHighlight,
    includeAiMemory,
    setIncludeAiMemory,
    loadMore,
    hasMore,
    removeResult,
    scope,
    setScope,
  } = useSearchStore();
  const { openPage, deletePage, folders } = usePagesStore();
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const selectedRowRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<ResultMenu | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
    } else if (debounceRef.current) {
      // Cancel a pending debounced search so it can't repopulate results after
      // the palette has been closed.
      clearTimeout(debounceRef.current);
    }
  }, [isOpen]);

  // Keep the keyboard-selected result visible. `block: "nearest"` is a no-op
  // when the row is already on screen, so hover-driven selection doesn't scroll.
  useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  // Dismiss the row context menu on any outside interaction.
  useEffect(() => {
    if (!menu) return;
    const dismiss = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    document.addEventListener("mousedown", dismiss);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", dismiss);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const handleChange = useCallback(
    (value: string) => {
      setQuery(value);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        search(value);
      }, 50);
    },
    [setQuery, search],
  );

  // Load the next page when the results list is scrolled near the bottom.
  const handleResultsScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 96) {
      void loadMore();
    }
  };

  const selectResult = useCallback(
    (index: number) => {
      const result = results[index];
      if (result) {
        setSearchHighlight(query);
        openPage(result.path);
        close();
      }
    },
    [results, openPage, close, query, setSearchHighlight],
  );

  const openMenu = useCallback((e: React.MouseEvent, index: number) => {
    e.preventDefault();
    e.stopPropagation();
    setConfirmingDelete(false);
    setMenu({ x: e.clientX, y: e.clientY, index });
  }, []);

  const handleDelete = useCallback(async () => {
    if (!menu) return;
    const result = results[menu.index];
    setMenu(null);
    if (result) {
      // Only drop the row if the delete actually succeeded — deletePage shows
      // an error toast and returns false on failure, so a failed delete leaves
      // the result visible instead of faking success.
      const ok = await deletePage(result.path);
      if (ok) removeResult(result.path);
    }
  }, [menu, results, deletePage, removeResult]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex(Math.min(selectedIndex + 1, results.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex(Math.max(selectedIndex - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        selectResult(selectedIndex);
      }
    },
    [close, selectedIndex, setSelectedIndex, results.length, selectResult],
  );

  if (!isOpen) return null;

  const selected = results[selectedIndex];
  const hasResults = results.length > 0;

  return (
    <div className="modal-overlay fixed inset-0 z-40 flex items-start justify-center pt-[15vh]">
      <div className="fixed inset-0 bg-black/30 dark:bg-black/50" onClick={close} />
      <div
        data-tour="search"
        className={`cmd-palette relative w-full overflow-hidden rounded-2xl border border-border bg-surface-raised ${
          hasResults ? "max-w-3xl" : "max-w-xl"
        }`}
      >
        {/* Search Input */}
        <div className="flex items-center border-b border-border px-4 py-4">
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            className="mr-3 shrink-0 text-accent"
          >
            <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" />
            <path
              d="M11 11l3.5 3.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => handleChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search pages..."
            className="flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted/60"
          />
          {loading && <SpinnerIcon size={16} className="animate-spin text-accent" />}
          <span className="ml-3 rounded border border-border/60 px-1.5 py-0.5 text-[10px] text-text-muted/70">
            ESC
          </span>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-3 border-b border-border/40 px-4 py-2">
          <select
            value={scopeToValue(scope)}
            onChange={(e) => setScope(valueToScope(e.target.value))}
            aria-label="Search scope"
            className="rounded border border-border/60 bg-surface px-1.5 py-0.5 text-[11px] text-text-primary outline-none"
          >
            <option value="all">All pages</option>
            <option value="secrets_only">Secrets only</option>
            {folders.map((f) => (
              <option key={f} value={`${FOLDER_PREFIX}${f}`}>
                {f}
              </option>
            ))}
          </select>
          <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-text-muted select-none">
            <input
              type="checkbox"
              checked={includeAiMemory}
              onChange={(e) => setIncludeAiMemory(e.target.checked)}
              className="h-3 w-3 accent-accent"
            />
            Include AI memory
          </label>
          {hasResults && (
            <span className="ml-auto text-[11px] text-text-muted/70">
              {results.length}
              {hasMore ? "+" : ""} result{results.length === 1 ? "" : "s"}
            </span>
          )}
        </div>

        {/* Results + preview */}
        {hasResults && (
          <div className="flex">
            <div
              className="max-h-[50vh] w-[44%] shrink-0 overflow-y-auto border-r border-border/40 py-1"
              onScroll={handleResultsScroll}
            >
              {results.map((result, i) => (
                <button
                  key={result.path}
                  ref={i === selectedIndex ? selectedRowRef : undefined}
                  onClick={() => selectResult(i)}
                  onMouseEnter={() => setSelectedIndex(i)}
                  onContextMenu={(e) => openMenu(e, i)}
                  className={`w-full px-4 py-2.5 text-left transition-all ${
                    i === selectedIndex
                      ? "bg-accent/10 border-l-2 border-accent"
                      : "border-l-2 border-transparent hover:bg-surface-overlay"
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-medium text-text-primary">
                      {result.title}
                    </span>
                    <span className="shrink-0 rounded bg-surface-overlay/50 px-1.5 py-px text-[10px] text-text-muted">
                      {result.folder}
                    </span>
                  </div>
                  {result.snippet && (
                    <p className="mt-0.5 line-clamp-1 text-[11px] text-text-muted">
                      {result.snippet}
                    </p>
                  )}
                </button>
              ))}
            </div>
            <div className="max-h-[50vh] min-w-0 flex-1">
              {selected && <SearchPreview key={selected.path} result={selected} />}
            </div>
          </div>
        )}

        {query && !loading && !hasResults && (
          <div className="px-4 py-8 text-center">
            <p className="text-sm text-text-muted">No results found</p>
            <p className="mt-1 text-[11px] text-text-muted/70">
              Try a different search term
            </p>
          </div>
        )}
      </div>

      {/* Row context menu (right-click) */}
      {menu && (
        <div
          className="fixed z-[100] min-w-[168px] rounded-lg border border-border bg-surface py-1 shadow-xl"
          style={{
            left: Math.min(menu.x, window.innerWidth - 184),
            top: Math.min(menu.y, window.innerHeight - 96),
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => selectResult(menu.index)}
            className="flex w-full items-center px-3 py-1.5 text-[13px] text-text-primary transition-colors hover:bg-accent/10"
          >
            Open
          </button>
          <button
            onClick={() => {
              if (confirmingDelete) {
                void handleDelete();
              } else {
                setConfirmingDelete(true);
              }
            }}
            className="flex w-full items-center px-3 py-1.5 text-[13px] text-danger transition-colors hover:bg-danger/10"
          >
            {confirmingDelete ? "Click again to delete" : "Delete (to trash)"}
          </button>
        </div>
      )}
    </div>
  );
}
