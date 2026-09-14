// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Search store — state for the full-text search panel.
 *
 * Backs the search overlay: the current query, scope filter, result list, and
 * keyboard-navigation cursor (`selectedIndex`). Queries run against the Rust
 * tantivy index via {@link cmd.searchPages}. `searchHighlight` carries the term
 * to the editor so a matched result can be highlighted after navigation.
 */
import { create } from "zustand";
import * as cmd from "@/lib/commands";
import type { SearchResult, SearchScope } from "@claspt/shared/types";

interface SearchStore {
  /** Current search query. */
  query: string;
  /** Search results. */
  results: SearchResult[];
  /** Whether the search panel is visible. */
  isOpen: boolean;
  /** Current scope filter. */
  scope: SearchScope;
  /** Whether AI-agent memory pages (`ai/memory/`) are included in results. */
  includeAiMemory: boolean;
  /** Loading state. */
  loading: boolean;
  /** Current page size requested from the backend (grows via load-more). */
  limit: number;
  /** Whether more results may exist beyond the current page. */
  hasMore: boolean;
  /** Selected result index for keyboard nav. */
  selectedIndex: number;
  /** Query to highlight in the editor after navigating to a result. */
  searchHighlight: string | null;

  setQuery: (query: string) => void;
  /** Run a search against the backend index; empty query clears results. */
  search: (query: string) => Promise<void>;
  /** Grow the page size and re-fetch (called when scrolling near the bottom). */
  loadMore: () => Promise<void>;
  setScope: (scope: SearchScope) => void;
  /** Toggle inclusion of AI memory pages; re-runs the current query. */
  setIncludeAiMemory: (include: boolean) => void;
  open: () => void;
  close: () => void;
  toggle: () => void;
  setSelectedIndex: (index: number) => void;
  setSearchHighlight: (highlight: string | null) => void;
  /** Remove a result from the list (after deleting the page from search). */
  removeResult: (path: string) => void;
  /** Rebuild the tantivy index from scratch; resolves to the document count. */
  rebuildIndex: () => Promise<number>;
}

/** Initial (and per-query reset) page size; load-more grows the limit by this. */
const PAGE_SIZE = 40;

// Monotonic request id. Every search/loadMore captures the current value and
// only commits its response if still the latest — so a slow older request can't
// clobber a newer query's results, and closing the palette invalidates any
// in-flight request.
let requestSeq = 0;

/** Zustand hook exposing search panel state and query actions. */
export const useSearchStore = create<SearchStore>((set, get) => ({
  query: "",
  results: [],
  isOpen: false,
  scope: "all",
  includeAiMemory: true,
  loading: false,
  limit: PAGE_SIZE,
  hasMore: false,
  selectedIndex: 0,
  searchHighlight: null,

  setQuery: (query) => set({ query }),

  search: async (query) => {
    if (!query.trim()) {
      requestSeq++; // invalidate any in-flight request
      set({ results: [], loading: false, limit: PAGE_SIZE, hasMore: false });
      return;
    }
    // Every fresh query resets the page size back to the first page.
    const seq = ++requestSeq;
    set({ loading: true, limit: PAGE_SIZE });
    try {
      const results = await cmd.searchPages(
        query,
        get().scope,
        get().includeAiMemory,
        PAGE_SIZE,
      );
      if (seq !== requestSeq) return; // superseded by a newer request
      set({
        results,
        loading: false,
        selectedIndex: 0,
        hasMore: results.length >= PAGE_SIZE,
      });
    } catch {
      if (seq !== requestSeq) return;
      set({ results: [], loading: false, hasMore: false });
    }
  },

  loadMore: async () => {
    const { query, scope, includeAiMemory, limit, loading, hasMore } = get();
    if (!query.trim() || loading || !hasMore) return;
    const nextLimit = limit + PAGE_SIZE;
    const seq = ++requestSeq;
    set({ loading: true });
    try {
      const results = await cmd.searchPages(query, scope, includeAiMemory, nextLimit);
      if (seq !== requestSeq) return;
      set({
        results,
        loading: false,
        limit: nextLimit,
        hasMore: results.length >= nextLimit,
      });
    } catch {
      if (seq !== requestSeq) return;
      set({ loading: false });
    }
  },

  setScope: (scope) => {
    set({ scope });
    // Re-run the active query so the scope change takes effect immediately.
    const { query } = get();
    if (query.trim()) {
      void get().search(query);
    }
  },

  setIncludeAiMemory: (include) => {
    set({ includeAiMemory: include });
    // Re-run the active query so the toggle takes effect immediately.
    const { query } = get();
    if (query.trim()) {
      void get().search(query);
    }
  },

  open: () => set({ isOpen: true }),
  close: () => {
    requestSeq++; // invalidate any in-flight search so it can't repopulate
    set({
      isOpen: false,
      query: "",
      results: [],
      selectedIndex: 0,
      searchHighlight: null,
      loading: false,
      limit: PAGE_SIZE,
      hasMore: false,
    });
  },
  toggle: () => {
    const { isOpen } = get();
    if (isOpen) {
      get().close();
    } else {
      get().open();
    }
  },

  setSelectedIndex: (index) => set({ selectedIndex: index }),

  setSearchHighlight: (highlight) => set({ searchHighlight: highlight }),

  removeResult: (path) => {
    const { results, selectedIndex } = get();
    const next = results.filter((r) => r.path !== path);
    set({
      results: next,
      selectedIndex: Math.min(selectedIndex, Math.max(0, next.length - 1)),
    });
  },

  rebuildIndex: async () => cmd.rebuildSearchIndex(),
}));
