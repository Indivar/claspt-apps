// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Pages store — the source of truth for notes, folders, and the open document.
 *
 * Responsibilities:
 *  - The sidebar page list (`pages`), the flat secret index (`secrets`), and the
 *    folder tree (`folders`).
 *  - The currently-open document (`activePage`) plus the CRUD/metadata actions
 *    that mutate it (create, update, delete, pin, archive, move, retag, toggle
 *    encryption) — each proxies to the Rust backend via `@/lib/commands`.
 *  - Multi-select + bulk operations for the sidebar.
 *  - Reconciling external edits: {@link PagesStore.refreshActivePage} re-reads the
 *    open file when a writer other than this editor (browser extension, MCP,
 *    sync) touches it, bumping `activePageExternalRev` to force an editor remount.
 *
 * Sync coupling: every write calls `schedulePushAfterSave()`, a debounced trigger
 * that collapses bursts of edits into a single background pull+push (see the
 * `PUSH_DEBOUNCE_MS` note below).
 */
import { create } from "zustand";
import { toast } from "sonner";
import { errorMessage } from "@/lib/error-message";
import * as cmd from "@/lib/commands";
import type { Page, PageSummary, SecretSummary } from "@claspt/shared/types";

// Debounced sync trigger. Every vault mutation resets this timer, so a
// burst of rapid edits only produces a single pull+push once the user has
// truly stopped for PUSH_DEBOUNCE_MS. Local saves + git commits happen on
// their own (faster) cadences — this timer is only about how often a new
// version lands on the server.
//
// 15s is long enough to collapse most "think-edit-think" cycles into one
// server version, short enough that a change reaches other devices soon
// after you step away. The Rust-side 30s auto-sync loop is the ceiling
// for anyone still typing continuously.
const PUSH_DEBOUNCE_MS = 15_000;

let pushTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePushAfterSave(): void {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    // Lazy-import to avoid a circular dependency between pages-store and
    // sync-store. syncV2 pulls then pushes; if either fails it surfaces on
    // the sync store's error state rather than bubbling up here.
    import("@/stores/sync-store").then(({ useSyncStore }) => {
      void useSyncStore.getState().syncV2();
    });
  }, PUSH_DEBOUNCE_MS);
}

interface PagesStore {
  /** All page summaries for sidebar display. */
  pages: PageSummary[];
  /** All secret summaries across all pages. */
  secrets: SecretSummary[];
  /** Currently active page (full content loaded). */
  activePage: Page | null;
  /** True after the first loadPages() call completes. */
  pagesLoaded: boolean;
  /** Loading state. */
  loading: boolean;
  /** Error message. */
  error: string | null;
  /** Whether to show archived pages in the sidebar. */
  showArchived: boolean;
  /** All folder paths (including nested), e.g. ["credentials", "credentials/work", "general"]. */
  folders: string[];
  /**
   * Bumps every time refreshActivePage detects an EXTERNAL change to the open
   * page (browser extension, MCP, sync, etc.). The editor uses this in its
   * `key` so external changes force a remount with fresh content. Self-saves
   * via `updatePage` deliberately do NOT bump this — they set activePage in
   * place, and the editor's local state is already in sync with the saved
   * content.
   */
  activePageExternalRev: number;

  /** Set of selected page paths for bulk operations. */
  selectedPaths: Set<string>;
  /** Whether selection mode is active. */
  selectionMode: boolean;

  // Selection
  toggleSelect: (path: string) => void;
  selectRange: (from: string, to: string, allPaths: string[]) => void;
  clearSelection: () => void;
  setSelectionMode: (on: boolean) => void;

  // Bulk operations
  bulkDelete: () => Promise<void>;
  bulkMove: (folder: string) => Promise<void>;
  bulkArchive: () => Promise<void>;
  bulkPin: () => Promise<void>;

  loadPages: () => Promise<void>;
  loadSecrets: () => Promise<void>;
  /**
   * Re-read the currently-open page from disk. Used by the pages-changed
   * listener so external writers (browser extension, MCP, sync) can't leave
   * the editor showing stale content. If the page no longer exists, clears
   * activePage so the editor doesn't display a phantom file.
   */
  refreshActivePage: () => Promise<void>;
  openPage: (path: string) => Promise<void>;
  createPage: (title: string, folder: string, content?: string) => Promise<Page | null>;
  updatePage: (path: string, content: string) => Promise<void>;
  /** Delete a page; resolves `true` on success, `false` on failure (a toast is
   * shown on failure). Callers can key cleanup (e.g. removing a search result)
   * on the result rather than assuming success. */
  deletePage: (path: string) => Promise<boolean>;
  duplicatePage: (path: string) => Promise<void>;
  togglePin: (path: string) => Promise<void>;
  toggleArchive: (path: string) => Promise<void>;
  setMemoryReviewed: (path: string, reviewed: boolean) => Promise<void>;
  setShowArchived: (show: boolean) => void;
  movePage: (path: string, newFolder: string) => Promise<void>;
  updateTitle: (path: string, title: string) => Promise<void>;
  updateTags: (path: string, tags: string[]) => Promise<void>;
  toggleEncryption: (path: string) => Promise<void>;
  closePage: () => void;
  clearError: () => void;
  loadFolders: () => Promise<void>;
  createFolder: (name: string) => Promise<string | null>;
  renameFolder: (oldName: string, newName: string) => Promise<boolean>;
  deleteFolder: (name: string, action: string) => Promise<boolean>;
}

/** Zustand hook exposing the page/folder list, open document, and CRUD actions. */
export const usePagesStore = create<PagesStore>((set, get) => ({
  pages: [],
  secrets: [],
  activePage: null,
  pagesLoaded: false,
  selectedPaths: new Set<string>(),
  selectionMode: false,
  loading: false,
  error: null,
  showArchived: false,
  folders: [],
  activePageExternalRev: 0,

  loadPages: async () => {
    try {
      const pages = await cmd.listPages();
      set({ pages, pagesLoaded: true });
    } catch (e) {
      set({ error: errorMessage(e) });
    }
  },

  loadSecrets: async () => {
    try {
      const secrets = await cmd.listSecrets();
      set({ secrets });
    } catch (e) {
      set({ error: errorMessage(e) });
    }
  },

  refreshActivePage: async () => {
    const { activePage } = get();
    if (!activePage) return;
    const path = activePage.path;
    try {
      const fresh = await cmd.readPage(path);
      // Only commit if the user hasn't already navigated elsewhere while the
      // re-read was in flight, and the content actually changed (avoids React
      // remount churn when nothing relevant moved).
      const current = get().activePage;
      if (current?.path !== path) return;
      if (
        fresh.content === current.content &&
        fresh.meta.updated_at === current.meta.updated_at
      )
        return;
      // External change confirmed — bump the revision so the editor remounts
      // with the fresh doc. Without this, the editor's local liveContent
      // would still hold the stale text and overwrite the change on the next
      // autosave (the original "extension delete didn't stick" symptom).
      set({ activePage: fresh, activePageExternalRev: get().activePageExternalRev + 1 });
    } catch (e) {
      // NotFound means the file was deleted out from under us — close the
      // editor so it doesn't keep showing stale content. Other errors stay
      // silent: we don't want a transient read failure to disrupt the user.
      const msg = errorMessage(e);
      if (/not.?found/i.test(msg) || /no such file/i.test(msg)) {
        const current = get().activePage;
        if (current?.path === path) set({ activePage: null });
      }
    }
  },

  openPage: async (path) => {
    // Clear activePage first so a failing read produces a visible change
    // instead of appearing to silently ignore the click. Previously, when
    // read_page threw for a malformed imported page, activePage kept its
    // prior value and the user saw "nothing happened".
    set({ loading: true, error: null, activePage: null });
    try {
      const page = await cmd.readPage(path);
      set({ activePage: page, loading: false });
    } catch (e) {
      const msg = errorMessage(e);
      console.error("[pages-store] openPage failed", { path, error: e });
      set({ error: `Couldn't open "${path}": ${msg}`, loading: false });
    }
  },

  createPage: async (title, folder, content = "") => {
    set({ error: null });
    try {
      const page = await cmd.createPage(title, folder, content);
      set({ activePage: page });
      await get().loadPages();
      schedulePushAfterSave();
      return page;
    } catch (e) {
      set({ error: errorMessage(e) });
      return null;
    }
  },

  updatePage: async (path, content) => {
    try {
      const page = await cmd.updatePage(path, content);
      set({ activePage: page });
      await get().loadPages();
      schedulePushAfterSave();
    } catch (e) {
      set({ error: errorMessage(e) });
      // Rethrow so the editor's autosave can tell the write actually failed
      // (e.g. readonly DB after auto-lock) and KEEP the crash-recovery draft
      // instead of showing a false "Saved" and deleting it.
      throw e;
    }
  },

  deletePage: async (path) => {
    try {
      await cmd.deletePage(path);
      const { activePage } = get();
      if (activePage?.path === path) {
        set({ activePage: null });
      }
      await get().loadPages();
      schedulePushAfterSave();
      return true;
    } catch (e) {
      // Surface the failure directly — the editor's error banner only shows
      // when no page is open, so a delete triggered from search/sidebar while
      // editing would otherwise fail silently and look like it succeeded.
      const msg = errorMessage(e);
      set({ error: msg });
      toast.error(`Couldn't delete page: ${msg}`);
      return false;
    }
  },

  duplicatePage: async (path) => {
    try {
      const page = await cmd.duplicatePage(path);
      set({ activePage: page });
      await get().loadPages();
      schedulePushAfterSave();
    } catch (e) {
      set({ error: errorMessage(e) });
    }
  },

  togglePin: async (path) => {
    try {
      const page = await cmd.togglePin(path);
      const { activePage } = get();
      if (activePage?.path === path) {
        set({ activePage: page });
      }
      await get().loadPages();
      schedulePushAfterSave();
    } catch (e) {
      set({ error: errorMessage(e) });
    }
  },

  toggleArchive: async (path) => {
    try {
      const page = await cmd.toggleArchive(path);
      const { activePage } = get();
      if (activePage?.path === path) {
        set({ activePage: page });
      }
      await get().loadPages();
      schedulePushAfterSave();
    } catch (e) {
      set({ error: errorMessage(e) });
    }
  },

  setMemoryReviewed: async (path, reviewed) => {
    try {
      const page = await cmd.setMemoryReviewed(path, reviewed);
      const { activePage } = get();
      if (activePage?.path === path) {
        set({ activePage: page });
      }
      await get().loadPages();
      schedulePushAfterSave();
    } catch (e) {
      set({ error: errorMessage(e) });
    }
  },

  setShowArchived: (show) => set({ showArchived: show }),

  // ── Selection ──

  toggleSelect: (path) => {
    const next = new Set(get().selectedPaths);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
    }
    set({ selectedPaths: next, selectionMode: next.size > 0 });
  },

  selectRange: (from, to, allPaths) => {
    const fromIdx = allPaths.indexOf(from);
    const toIdx = allPaths.indexOf(to);
    if (fromIdx === -1 || toIdx === -1) return;
    const [start, end] = fromIdx < toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx];
    const next = new Set(get().selectedPaths);
    for (let i = start; i <= end; i++) {
      const p = allPaths[i];
      if (p) next.add(p);
    }
    set({ selectedPaths: next, selectionMode: true });
  },

  clearSelection: () => set({ selectedPaths: new Set(), selectionMode: false }),

  setSelectionMode: (on) => {
    if (!on) {
      set({ selectedPaths: new Set(), selectionMode: false });
    } else {
      set({ selectionMode: true });
    }
  },

  // ── Bulk Operations ──

  bulkDelete: async () => {
    const { selectedPaths, activePage } = get();
    try {
      await cmd.deletePagesBulk([...selectedPaths]);
    } catch (e) {
      set({ error: errorMessage(e) });
    }
    if (activePage && selectedPaths.has(activePage.path)) {
      set({ activePage: null });
    }
    set({ selectedPaths: new Set(), selectionMode: false });
    await get().loadPages();
    schedulePushAfterSave();
  },

  bulkMove: async (folder) => {
    const { selectedPaths } = get();
    for (const path of selectedPaths) {
      try {
        await cmd.movePage(path, folder);
      } catch (e) {
        set({ error: errorMessage(e) });
        break;
      }
    }
    set({ selectedPaths: new Set(), selectionMode: false });
    await get().loadPages();
    schedulePushAfterSave();
  },

  bulkArchive: async () => {
    const { selectedPaths } = get();
    for (const path of selectedPaths) {
      try {
        await cmd.toggleArchive(path);
      } catch (e) {
        set({ error: errorMessage(e) });
        break;
      }
    }
    set({ selectedPaths: new Set(), selectionMode: false });
    await get().loadPages();
    schedulePushAfterSave();
  },

  bulkPin: async () => {
    const { selectedPaths } = get();
    for (const path of selectedPaths) {
      try {
        await cmd.togglePin(path);
      } catch (e) {
        set({ error: errorMessage(e) });
        break;
      }
    }
    set({ selectedPaths: new Set(), selectionMode: false });
    await get().loadPages();
    schedulePushAfterSave();
  },

  movePage: async (path, newFolder) => {
    try {
      const page = await cmd.movePage(path, newFolder);
      set({ activePage: page });
      await get().loadPages();
      schedulePushAfterSave();
    } catch (e) {
      set({ error: errorMessage(e) });
    }
  },

  updateTitle: async (path, title) => {
    try {
      const page = await cmd.updateTitle(path, title);
      const { activePage } = get();
      if (activePage?.path === path) {
        set({ activePage: page });
      }
      await get().loadPages();
      schedulePushAfterSave();
    } catch (e) {
      set({ error: errorMessage(e) });
    }
  },

  updateTags: async (path, tags) => {
    try {
      const page = await cmd.updateTags(path, tags);
      const { activePage } = get();
      if (activePage?.path === path) {
        set({ activePage: page });
      }
      await get().loadPages();
      schedulePushAfterSave();
    } catch (e) {
      set({ error: errorMessage(e) });
    }
  },

  toggleEncryption: async (path) => {
    try {
      const page = await cmd.toggleEncryption(path);
      set({ activePage: page });
      await get().loadPages();
      schedulePushAfterSave();
    } catch (e) {
      set({ error: errorMessage(e) });
    }
  },

  closePage: () => set({ activePage: null }),
  clearError: () => set({ error: null }),

  loadFolders: async () => {
    try {
      const folders = await cmd.listFolders();
      set({ folders });
    } catch (e) {
      set({ error: errorMessage(e) });
    }
  },

  createFolder: async (name) => {
    try {
      const folderName = await cmd.createFolder(name);
      await get().loadFolders();
      schedulePushAfterSave();
      return folderName;
    } catch (e) {
      set({ error: errorMessage(e) });
      return null;
    }
  },

  renameFolder: async (oldName, newName) => {
    try {
      await cmd.renameFolder(oldName, newName);
      await get().loadFolders();
      await get().loadPages();
      schedulePushAfterSave();
      return true;
    } catch (e) {
      set({ error: errorMessage(e) });
      return false;
    }
  },

  deleteFolder: async (name, action) => {
    try {
      await cmd.deleteFolder(name, action);
      await get().loadFolders();
      await get().loadPages();
      schedulePushAfterSave();
      return true;
    } catch (e) {
      set({ error: errorMessage(e) });
      return false;
    }
  },
}));
