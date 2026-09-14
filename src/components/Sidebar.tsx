// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Sidebar — the primary navigation panel: page/folder tree and secrets list.
 *
 * Hosts two tabs (Pages and Secrets), sorting, tag filtering, archive
 * toggling, multi-select with bulk move/archive/delete, drag-and-drop of
 * pages and folders (@dnd-kit), inline folder creation, and a footer with
 * lock, quick-action buttons (search, share, import, generator, theme,
 * settings), license badge, sync status, and version. Also auto-starts the
 * onboarding tour on first unlock for fresh vaults, and refreshes when pages
 * change externally (API/MCP/inbox watcher).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { VERSION_DISPLAY } from "@/lib/version";
import * as cmd from "@/lib/commands";
import { usePagesStore } from "@/stores/pages-store";
import { useSearchStore } from "@/stores/search-store";
import { useUIStore, applyUIScale } from "@/stores/ui-store";
import { useVaultStore } from "@/stores/vault-store";
import type { PageSummary, SecretSummary, LicenseStatus } from "@claspt/shared/types";
import { BrandLogo } from "@/components/BrandLogo";
import { ShareBadge } from "@/components/ShareBadge";
import { SyncStatusBar } from "@/components/SyncStatusBar";
import { LockClosedIcon } from "@/components/ui/icons";
import { useClickOutside } from "@/hooks/use-click-outside";
import { kbd } from "@/lib/platform";
import { formatTimeAgo } from "@claspt/shared/format-time";
import { FolderSection } from "@/components/FolderSection";
import { buildFolderTree } from "@/components/folder-tree";

type SortField = "updated_at" | "created_at" | "title";
type SortOrder = "asc" | "desc";
type SidebarTab = "pages" | "secrets";

/** Sort pages by the chosen field/order, always keeping pinned pages first. */
function sortPages(
  pages: PageSummary[],
  field: SortField,
  order: SortOrder,
): PageSummary[] {
  return [...pages].sort((a, b) => {
    // Pinned pages always first
    if (a.meta.pinned !== b.meta.pinned) return a.meta.pinned ? -1 : 1;

    let cmp: number;
    if (field === "title") {
      cmp = a.meta.title.localeCompare(b.meta.title, undefined, {
        sensitivity: "base",
      });
    } else {
      cmp = new Date(a.meta[field]).getTime() - new Date(b.meta[field]).getTime();
    }
    return order === "asc" ? cmp : -cmp;
  });
}

/** Sort secrets by label or date; secrets have no updated_at so it falls back
 *  to created_at. */
function sortSecrets(
  secrets: SecretSummary[],
  field: SortField,
  order: SortOrder,
): SecretSummary[] {
  return [...secrets].sort((a, b) => {
    let cmp: number;
    if (field === "title") {
      cmp = a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
    } else if (field === "created_at") {
      cmp = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    } else {
      // updated_at → fall back to created_at for secrets
      cmp = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    }
    return order === "asc" ? cmp : -cmp;
  });
}

/** Action bar shown above the list in multi-select mode: move/archive/delete
 *  the selected pages, with an inline delete confirmation. */
function BulkActionBar({
  count,
  folders,
  onMove,
  onArchive,
  onDelete,
  onCancel,
}: {
  count: number;
  folders: string[];
  onMove: (folder: string) => void;
  onArchive: () => void;
  onDelete: () => void;
  onCancel: () => void;
}) {
  const [moveOpen, setMoveOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const moveRef = useRef<HTMLDivElement>(null);
  useClickOutside(moveRef, () => setMoveOpen(false), moveOpen);

  return (
    <div className="flex flex-col border-b border-border/50 bg-accent/5">
      <div className="flex items-center gap-1 px-2 py-1.5">
        <span className="text-[12px] font-medium text-accent mr-1">{count} selected</span>
        <div className="relative" ref={moveRef}>
          <button
            onClick={() => setMoveOpen(!moveOpen)}
            className="rounded px-2 py-1 text-[11px] text-text-secondary hover:bg-surface-overlay"
            title="Move selected"
          >
            Move
          </button>
          {moveOpen && (
            <div className="absolute left-0 top-full z-50 mt-1 min-w-36 max-h-48 overflow-y-auto rounded-lg border border-border bg-surface-raised py-1 shadow-lg">
              {folders.map((f) => (
                <button
                  key={f}
                  onClick={() => {
                    onMove(f);
                    setMoveOpen(false);
                  }}
                  className="flex w-full items-center px-3 py-1.5 text-left text-[12px] text-text-secondary hover:bg-surface-overlay"
                >
                  {f}
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          onClick={onArchive}
          className="rounded px-2 py-1 text-[11px] text-text-secondary hover:bg-surface-overlay"
          title="Archive selected"
        >
          Archive
        </button>
        <button
          onClick={() => setConfirmDelete(true)}
          className="rounded px-2 py-1 text-[11px] text-danger hover:bg-danger/10"
          title="Delete selected"
        >
          Delete
        </button>
        <button
          onClick={onCancel}
          className="ml-auto rounded px-2 py-1 text-[11px] text-text-dim hover:text-text-muted"
        >
          Cancel
        </button>
      </div>
      {confirmDelete && (
        <div className="flex items-center gap-2 px-2 pb-1.5">
          <span className="text-[11px] text-danger">
            Permanently delete {count} page{count !== 1 ? "s" : ""}?
          </span>
          <button
            onClick={() => {
              onDelete();
              setConfirmDelete(false);
            }}
            className="rounded bg-danger/20 px-2 py-0.5 text-[11px] font-medium text-danger hover:bg-danger/30"
          >
            Yes, delete
          </button>
          <button
            onClick={() => setConfirmDelete(false)}
            className="rounded px-2 py-0.5 text-[11px] text-text-dim hover:text-text-muted"
          >
            No
          </button>
        </div>
      )}
    </div>
  );
}

/** A single page row: draggable, selectable, with pin/archive/move/duplicate/
 *  delete context menu. Memoized since the list can be long. */
const PageItem = React.memo(function PageItem({
  page,
  isActive,
  isSelected,
  selectionMode,
  onClick,
  onSelect,
  onTogglePin,
  onToggleArchive,
  onDelete,
  onDuplicate,
  folders,
  onMoveTo,
  compact,
}: {
  page: PageSummary;
  isActive: boolean;
  isSelected?: boolean;
  selectionMode?: boolean;
  onClick: () => void;
  onSelect?: (e?: React.MouseEvent) => void;
  onTogglePin: () => void;
  onToggleArchive: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  folders?: string[];
  onMoveTo?: (folder: string) => void;
  compact?: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [moveMenuOpen, setMoveMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 });
  const menuRef = useRef<HTMLDivElement>(null);

  useClickOutside(
    menuRef,
    () => {
      setMenuOpen(false);
      setMoveMenuOpen(false);
    },
    menuOpen,
  );

  const handleClick = (e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) {
      e.preventDefault();
      onSelect?.(e);
    } else if (selectionMode) {
      e.preventDefault();
      onSelect?.(e);
    } else {
      onClick();
    }
  };

  // @dnd-kit draggable — this page can be dragged to another folder
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({
    id: `page:${page.path}`,
    data: { type: "page", path: page.path, folder: page.meta.folder },
  });

  const openMenu = (e: React.MouseEvent) => {
    // Clamp menu position so it doesn't overflow the viewport
    const x = Math.min(e.clientX, window.innerWidth - 200);
    const y = Math.min(e.clientY, window.innerHeight - 200);
    setMenuPos({ x, y });
    setMenuOpen(true);
    setMoveMenuOpen(false);
  };

  return (
    <div className="group relative" ref={setDragRef} {...listeners} {...attributes}>
      <button
        onClick={handleClick}
        onContextMenu={(e) => {
          e.preventDefault();
          openMenu(e);
        }}
        className={`page-item flex w-full items-center gap-1 pr-2 text-left transition-colors hover:bg-surface-overlay/40 ${compact ? "h-[22px]" : "py-1"} ${isActive ? "active" : ""} ${isSelected ? "bg-accent/10 ring-1 ring-accent/30" : ""} ${page.meta.archived ? "opacity-50" : ""} ${isDragging ? "opacity-40" : ""}`}
      >
        {/* Selection checkbox (shown in selection mode or on hover with Cmd) */}
        {selectionMode ? (
          <span
            className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
              isSelected
                ? "border-accent bg-accent text-background"
                : "border-text-dim/40 bg-transparent"
            }`}
          >
            {isSelected && (
              <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" />
              </svg>
            )}
          </span>
        ) : (
          /* Document icon — outlined with dog-ear to distinguish from folder */
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            className="shrink-0 text-text-muted/60"
          >
            <path
              d="M4.5 1.5h5l3 3v9a1 1 0 01-1 1h-7a1 1 0 01-1-1v-11a1 1 0 011-1z"
              stroke="currentColor"
              strokeWidth="1.2"
            />
            <path
              d="M9.5 1.5v3h3"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
        <span className="flex min-w-0 flex-1 items-center gap-1 truncate text-[13px] text-text-primary">
          {page.meta.pinned && (
            <svg
              width="10"
              height="10"
              viewBox="0 0 16 16"
              fill="currentColor"
              className="shrink-0 text-accent"
            >
              <path d="M9.828 1.172a1 1 0 011.414 0l3.586 3.586a1 1 0 010 1.414l-3.586 3.586-1.414-1.414L12.07 6.12 6.12 12.07l-2.242 2.242a1 1 0 01-1.414-1.414L4.706 10.656l-1.414-1.414a1 1 0 010-1.414L6.878 4.242 5.464 2.828z" />
            </svg>
          )}
          {page.meta.encrypted && (
            <LockClosedIcon size={10} className="shrink-0 text-accent" />
          )}
          <span className="truncate">{page.meta.title}</span>
          {page.meta.archived && (
            <span className="shrink-0 rounded bg-text-muted/10 px-1 py-px text-[10px] text-text-muted">
              A
            </span>
          )}
        </span>
        {compact ? (
          <span className="shrink-0 text-[11px] text-text-muted/70">
            {formatTimeAgo(page.meta.updated_at)}
          </span>
        ) : (
          <span className="shrink-0 text-[11px] text-text-muted/70">
            {formatTimeAgo(page.meta.updated_at)}
          </span>
        )}
      </button>
      {/* "..." menu trigger */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          if (menuOpen) {
            setMenuOpen(false);
          } else {
            openMenu(e);
          }
        }}
        className="absolute right-0.5 top-0.5 flex h-[18px] w-[18px] items-center justify-center rounded text-text-muted/60 opacity-0 transition-all hover:bg-surface-overlay hover:text-text-secondary group-hover:opacity-100"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <circle cx="8" cy="3" r="1.2" />
          <circle cx="8" cy="8" r="1.2" />
          <circle cx="8" cy="13" r="1.2" />
        </svg>
      </button>
      {/* Context menu — fixed positioning to avoid sidebar overflow clipping */}
      {menuOpen && (
        <div
          ref={menuRef}
          style={{ left: menuPos.x, top: menuPos.y }}
          className="fixed z-[100] min-w-44 rounded-lg border border-border bg-surface-raised py-1 shadow-lg"
        >
          <button
            onClick={() => {
              onTogglePin();
              setMenuOpen(false);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-text-secondary hover:bg-surface-overlay"
          >
            {page.meta.pinned ? "Unpin" : "Pin"}
          </button>
          <button
            onClick={() => {
              onToggleArchive();
              setMenuOpen(false);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-text-secondary hover:bg-surface-overlay"
          >
            {page.meta.archived ? "Unarchive" : "Archive"}
          </button>
          {folders &&
            onMoveTo &&
            folders.filter((f) => f !== page.meta.folder).length > 0 && (
              <div className="relative">
                <button
                  onClick={() => setMoveMenuOpen(!moveMenuOpen)}
                  className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[13px] text-text-secondary hover:bg-surface-overlay"
                >
                  Move to...
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M6 3l5 5-5 5z" />
                  </svg>
                </button>
                {moveMenuOpen && (
                  <div className="absolute left-full top-0 z-[101] ml-1 min-w-36 max-h-60 overflow-y-auto rounded-lg border border-border bg-surface-raised py-1 shadow-lg">
                    {folders
                      .filter((f) => f !== page.meta.folder)
                      .map((f) => {
                        const d = f.split("/").length - 1;
                        const label = f.split("/").pop();
                        return (
                          <button
                            key={f}
                            onClick={() => {
                              onMoveTo(f);
                              setMenuOpen(false);
                            }}
                            className="flex w-full items-center gap-2 py-1.5 text-left text-[13px] text-text-secondary hover:bg-surface-overlay"
                            style={{
                              paddingLeft: `${12 + d * 12}px`,
                              paddingRight: "12px",
                            }}
                          >
                            {label}
                          </button>
                        );
                      })}
                  </div>
                )}
              </div>
            )}
          <button
            onClick={() => {
              onDuplicate();
              setMenuOpen(false);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-text-secondary hover:bg-surface-overlay"
          >
            Duplicate
          </button>
          <div className="my-1 border-t border-border/40" />
          <button
            onClick={() => {
              onDelete();
              setMenuOpen(false);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-danger hover:bg-danger/10"
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
});

/** A single secret row in the Secrets tab; opens its host page on click. */
const SecretItem = React.memo(function SecretItem({
  secret,
  onClick,
}: {
  secret: SecretSummary;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="page-item w-full rounded-lg px-3 py-2.5 text-left"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="flex items-center gap-1.5 truncate text-[13px] font-medium text-text-primary">
          <LockClosedIcon size={14} className="shrink-0 text-secret" />
          {secret.label}
        </span>
      </div>
      <div className="mt-1.5 flex items-center gap-1.5">
        <span className="truncate text-[12px] text-text-muted">{secret.page_title}</span>
        <span className="rounded bg-surface-overlay/60 px-1.5 py-px text-[11px] text-text-muted">
          {secret.folder}
        </span>
      </div>
    </button>
  );
});

/** Sort-field selector plus an ascending/descending toggle button. */
function SortDropdown({
  field,
  order,
  onFieldChange,
  onOrderToggle,
}: {
  field: SortField;
  order: SortOrder;
  onFieldChange: (f: SortField) => void;
  onOrderToggle: () => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <select
        value={field}
        onChange={(e) => onFieldChange(e.target.value as SortField)}
        className="focus-accent rounded-md border border-border/60 bg-surface px-1.5 py-0.5 text-[12px] text-text-secondary outline-none"
      >
        <option value="updated_at">Modified</option>
        <option value="created_at">Created</option>
        <option value="title">Name</option>
      </select>
      <button
        onClick={onOrderToggle}
        className="icon-btn p-0.5 text-text-muted"
        title={order === "asc" ? "Ascending" : "Descending"}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          {order === "asc" ? (
            <path
              d="M8 3v10M4 7l4-4 4 4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ) : (
            <path
              d="M8 13V3M4 9l4 4 4-4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}
        </svg>
      </button>
    </div>
  );
}

/** Drop zone at the top of the folder tree — drop here to move items to root level.
 *  Pages go to "general", folders become top-level. Only visible while dragging. */
function RootDropZone() {
  const { setNodeRef, isOver } = useDroppable({
    id: "root-drop-zone",
    data: { type: "root" },
  });
  return (
    <div
      ref={setNodeRef}
      className={`mb-1 flex h-[24px] items-center rounded-lg border border-dashed px-3 text-[12px] transition-colors ${
        isOver
          ? "border-accent bg-accent/15 text-accent"
          : "border-border/50 text-text-muted/60"
      }`}
    >
      {isOver ? "Drop here" : "Root level"}
    </div>
  );
}

/** Inline text input for naming a new folder; Enter creates, Escape cancels. */
function InlineFolderCreate() {
  const [value, setValue] = useState("");
  const { createFolder } = usePagesStore();
  const { setCreatingFolder } = useUIStore();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = async () => {
    const trimmed = value.trim();
    if (trimmed) {
      await createFolder(trimmed);
    }
    setCreatingFolder(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSubmit();
    } else if (e.key === "Escape") {
      setCreatingFolder(false);
    }
  };

  return (
    <div className="flex h-[22px] items-center gap-1 px-1">
      <div className="flex h-4 w-4 shrink-0 items-center justify-center text-text-muted/70">
        <svg
          width="10"
          height="10"
          viewBox="0 0 16 16"
          fill="currentColor"
          className="rotate-90"
        >
          <path d="M6 3l5 5-5 5z" />
        </svg>
      </div>
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={handleSubmit}
        placeholder="Folder name..."
        className="min-w-0 flex-1 rounded border border-accent bg-surface px-1 py-0 text-[13px] text-text-primary outline-none"
      />
    </div>
  );
}

/** The application sidebar: page/folder tree, secrets list, and footer. */
export function Sidebar() {
  const {
    pages,
    secrets,
    activePage,
    loadPages,
    loadSecrets,
    openPage,
    createPage,
    toggleArchive,
    togglePin,
    deletePage,
    duplicatePage,
    showArchived,
    setShowArchived,
    folders,
    loadFolders,
    movePage,
    selectedPaths,
    selectionMode,
    toggleSelect,
    clearSelection,
    bulkDelete,
    bulkMove,
    bulkArchive,
    selectRange,
    refreshActivePage,
  } = usePagesStore();
  const lastSelectedRef = useRef<string | null>(null);
  const { lock, config, updateConfig } = useVaultStore();
  const {
    sidebarOpen,
    toggleSidebar,
    theme,
    cycleTheme,
    setGeneratorOpen,
    setImportModalOpen,
    setShareModalOpen,
    setSettingsOpen,
    tagFilter,
    setTagFilter,
    creatingFolder,
    setCreatingFolder,
    sidebarWidth,
    sidebarDensity,
    toggleSidebarDensity,
    collapsedFolders,
    collapseAllFolders,
    expandAllFolders,
  } = useUIStore();
  const { toggle: toggleSearch } = useSearchStore();
  const [allTags, setAllTags] = useState<string[]>([]);
  const [tab, setTab] = useState<SidebarTab>("pages");
  const [sortField, setSortField] = useState<SortField>("title");
  const [sortOrder, setSortOrder] = useState<SortOrder>("asc");
  const [licenseStatus, setLicenseStatus] = useState<LicenseStatus | null>(null);
  const settingsOpen = useUIStore((s) => s.settingsOpen);

  // Fetch license status on mount and whenever settings panel closes
  // (license may have been activated/deactivated in settings)
  useEffect(() => {
    if (!settingsOpen) {
      cmd
        .getLicenseStatus()
        .then(setLicenseStatus)
        .catch(() => {});
    }
  }, [settingsOpen]);

  const handleScaleChange = async (delta: number) => {
    if (!config) return;
    const current = config.ui_scale ?? 1.0;
    const next = Math.round(Math.min(1.4, Math.max(0.8, current + delta)) * 100) / 100;
    if (next === current) return;
    applyUIScale(next);
    await updateConfig({ ...config, ui_scale: next });
  };

  const handleThemeCycle = async () => {
    cycleTheme();
    const nextTheme = useUIStore.getState().theme;
    if (config) {
      await updateConfig({ ...config, theme: nextTheme });
    }
  };

  useEffect(() => {
    loadPages();
    loadFolders();
  }, [loadPages, loadFolders]);

  // Start with all folders collapsed after a fresh unlock (faster initial render)
  useEffect(() => {
    if (folders.length > 0 && Object.keys(collapsedFolders).length === 0) {
      collapseAllFolders(folders);
    }
  }, [folders, collapsedFolders, collapseAllFolders]);

  // Refresh when pages change externally (API, MCP, inbox watcher).
  // Also refresh the open page so the editor doesn't show stale content
  // (and the autosave doesn't write the stale content back).
  useEffect(() => {
    const unlisten = listen("pages-changed", () => {
      loadPages();
      loadFolders();
      refreshActivePage();
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [loadPages, loadFolders, refreshActivePage]);

  // The tour is NOT started automatically.
  //
  // It used to fire 500ms after a new vault loaded, which put a full-screen
  // overlay in front of someone who had not yet connected anything or written
  // anything — before the first thing they actually came to do. Two overlays
  // back to back (recovery key, then tour) was worse still.
  //
  // It is now offered as a choice at the end of setup, and from Help, so anyone
  // who wants it asks for it. See `startTour` in ui-store.

  // Load all tags when pages change (debounced to avoid rapid IPC calls)
  useEffect(() => {
    const timer = setTimeout(() => {
      cmd
        .listTags()
        .then(setAllTags)
        .catch(() => {});
    }, 300);
    return () => clearTimeout(timer);
  }, [pages]);

  // Reload secrets when pages change (debounced)
  useEffect(() => {
    const timer = setTimeout(() => {
      loadSecrets();
    }, 300);
    return () => clearTimeout(timer);
  }, [pages, loadSecrets]);

  const filteredPages = useMemo(() => {
    let result = pages;
    if (!showArchived) result = result.filter((p) => !p.meta.archived);
    if (tagFilter) result = result.filter((p) => p.meta.tags?.includes(tagFilter));
    return result;
  }, [pages, tagFilter, showArchived]);

  const sortedPages = useMemo(
    () => sortPages(filteredPages, sortField, sortOrder),
    [filteredPages, sortField, sortOrder],
  );

  const pagesByFolder = useMemo(() => {
    const grouped: Record<string, PageSummary[]> = {};
    for (const folder of folders) {
      grouped[folder] = [];
    }
    for (const page of sortedPages) {
      const folder = page.meta.folder;
      if (!grouped[folder]) {
        grouped[folder] = [];
      }
      grouped[folder]!.push(page);
    }
    return grouped;
  }, [sortedPages, folders]);

  const folderTree = useMemo(() => buildFolderTree(folders), [folders]);

  // ── Drag-and-drop state (@dnd-kit) ──────────────────────────────
  const [draggedItem, setDraggedItem] = useState<{
    type: "page" | "folder";
    id: string;
    path: string;
    label: string;
    /** Number of items being dragged (>1 when multi-selected pages) */
    count: number;
  } | null>(null);
  // Require 8px movement before starting drag — prevents accidental drags on clicks
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const { active } = event;
      const data = active.data.current;
      if (!data) return;
      if (data.type === "page") {
        const page = sortedPages.find((p) => p.path === data.path);
        // If this page is part of a multi-selection, drag all selected pages
        const isPartOfSelection = selectionMode && selectedPaths.has(data.path);
        const count = isPartOfSelection ? selectedPaths.size : 1;
        const label =
          isPartOfSelection && count > 1
            ? `${count} pages`
            : (page?.meta.title ?? data.path);
        setDraggedItem({
          type: "page",
          id: String(active.id),
          path: data.path,
          label,
          count,
        });
      } else if (data.type === "folder") {
        setDraggedItem({
          type: "folder",
          id: String(active.id),
          path: data.path,
          label: data.path.split("/").pop() ?? data.path,
          count: 1,
        });
      }
    },
    [sortedPages, selectionMode, selectedPaths],
  );

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      const currentDrag = draggedItem;
      setDraggedItem(null);
      if (!over) return;

      const activeData = active.data.current;
      const overData = over.data.current;
      if (!activeData || !overData) return;

      // Determine target: either a folder or root-level drop zone
      const isRootDrop = overData.type === "root";
      const targetFolder: string | null = isRootDrop ? null : overData.path;

      if (activeData.type === "page") {
        const dest = targetFolder ?? "general"; // root drop → general
        if (currentDrag && currentDrag.count > 1) {
          // Multi-select: move all selected pages
          await bulkMove(dest);
        } else if (activeData.folder !== dest) {
          await movePage(activeData.path, dest);
        }
      } else if (activeData.type === "folder") {
        const srcPath: string = activeData.path;
        if (isRootDrop) {
          // Move folder to root level
          if (srcPath.includes("/")) {
            const folderName = srcPath.split("/").pop()!;
            await usePagesStore.getState().renameFolder(srcPath, folderName);
          }
          // Already at root — no-op
        } else if (
          targetFolder &&
          srcPath !== targetFolder &&
          !targetFolder.startsWith(srcPath + "/")
        ) {
          const folderName = srcPath.split("/").pop()!;
          const newPath = `${targetFolder}/${folderName}`;
          await usePagesStore.getState().renameFolder(srcPath, newPath);
        }
      }
    },
    [movePage, bulkMove, draggedItem],
  );
  // ── End DnD ─────────────────────────────────────────────────────

  const sortedSecrets = useMemo(
    () => sortSecrets(secrets, sortField, sortOrder),
    [secrets, sortField, sortOrder],
  );

  if (!sidebarOpen) {
    return (
      <div className="sidebar-panel flex w-11 flex-col items-center border-r border-border bg-surface-raised pt-3">
        <button
          onClick={toggleSidebar}
          className="icon-btn p-1.5 text-text-muted"
          title="Open sidebar"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path
              d="M6 3l5 5-5 5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
    );
  }

  return (
    <div
      style={{ width: sidebarWidth }}
      className="sidebar-panel sidebar-gradient flex shrink-0 flex-col border-r border-border"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3">
        <span className="flex items-center gap-2">
          <BrandLogo size="header" />
          <span className="brand-gradient text-base font-extrabold tracking-tight">
            Claspt
          </span>
          {licenseStatus && (
            <span
              className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none ${
                licenseStatus.is_pro && !licenseStatus.is_expired
                  ? "bg-accent/15 text-accent"
                  : "bg-surface-overlay/60 text-text-muted"
              }`}
            >
              {licenseStatus.is_trial
                ? "Trial"
                : licenseStatus.tier === "pro_plus"
                  ? "Pro+"
                  : licenseStatus.tier === "pro"
                    ? "Pro"
                    : "Free"}
            </span>
          )}
        </span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => handleScaleChange(-0.05)}
            className="icon-btn px-1 py-0.5 text-[13px] font-semibold text-text-muted"
            title={`Decrease UI scale (${Math.round((config?.ui_scale ?? 1.0) * 100)}%)`}
          >
            A-
          </button>
          <button
            onClick={() => handleScaleChange(0.05)}
            className="icon-btn px-1 py-0.5 text-[13px] font-semibold text-text-muted"
            title={`Increase UI scale (${Math.round((config?.ui_scale ?? 1.0) * 100)}%)`}
          >
            A+
          </button>
          <button
            onClick={toggleSearch}
            className="icon-btn p-1.5 text-text-muted"
            title={kbd("Search (Mod+K)")}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" />
              <path
                d="M11 11l3.5 3.5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
          <button
            onClick={toggleSidebar}
            className="icon-btn p-1.5 text-text-muted"
            title="Collapse sidebar"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path
                d="M10 3l-5 5 5 5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>

      {/* Tab Bar */}
      <div className="flex border-b border-border px-2 pt-1">
        <button
          onClick={() => setTab("pages")}
          className={`flex-1 rounded-t-lg py-2 text-[13px] font-semibold transition-all ${
            tab === "pages"
              ? "border-b-2 border-accent bg-accent/5 text-accent"
              : "text-text-muted hover:text-text-secondary"
          }`}
        >
          Pages
        </button>
        <button
          onClick={() => setTab("secrets")}
          className={`flex-1 rounded-t-lg py-2 text-[13px] font-semibold transition-all ${
            tab === "secrets"
              ? "border-b-2 border-accent bg-accent/5 text-accent"
              : "text-text-muted hover:text-text-secondary"
          }`}
        >
          Secrets
          {secrets.length > 0 && (
            <span className="ml-1.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent px-1.5 text-[11px] font-bold leading-none text-white">
              {secrets.length}
            </span>
          )}
        </button>
      </div>

      {/* Sort + Actions Bar */}
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-1">
          <SortDropdown
            field={sortField}
            order={sortOrder}
            onFieldChange={setSortField}
            onOrderToggle={() => setSortOrder((o) => (o === "asc" ? "desc" : "asc"))}
          />
          {tab === "pages" && folders.length > 0 && (
            <button
              onClick={() => {
                const allCollapsed =
                  folders.length > 0 && folders.every((f) => collapsedFolders[f]);
                if (allCollapsed) expandAllFolders();
                else collapseAllFolders(folders);
              }}
              className="icon-btn p-0.5 text-text-muted"
              title={
                folders.length > 0 && folders.every((f) => collapsedFolders[f])
                  ? "Expand all folders"
                  : "Collapse all folders"
              }
            >
              {folders.length > 0 && folders.every((f) => collapsedFolders[f]) ? (
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <path
                    d="M4 6l4 4 4-4"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M4 2l4 4 4-4"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <path
                    d="M4 10l4-4 4 4"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M4 14l4-4 4 4"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </button>
          )}
          <button
            onClick={toggleSidebarDensity}
            className="icon-btn p-0.5 text-text-muted"
            title={sidebarDensity === "compact" ? "Show details" : "Compact view"}
          >
            {sidebarDensity === "compact" ? (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <rect
                  x="2"
                  y="2"
                  width="12"
                  height="3"
                  rx="0.5"
                  stroke="currentColor"
                  strokeWidth="1.2"
                />
                <rect
                  x="2"
                  y="7"
                  width="12"
                  height="3"
                  rx="0.5"
                  stroke="currentColor"
                  strokeWidth="1.2"
                />
                <rect
                  x="2"
                  y="12"
                  width="8"
                  height="2"
                  rx="0.5"
                  stroke="currentColor"
                  strokeWidth="1.2"
                />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path
                  d="M2 3h12M2 6.5h12M2 10h12M2 13.5h8"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                />
              </svg>
            )}
          </button>
        </div>
        {tab === "pages" && (
          <div className="flex gap-1.5">
            <button
              onClick={() => setCreatingFolder(true)}
              className="rounded-lg px-2 py-1.5 text-[13px] text-text-muted transition-colors hover:bg-surface-overlay hover:text-text-secondary"
              title="New folder"
            >
              + Folder
            </button>
            <button
              data-tour="new-page"
              onClick={async () => {
                await createPage("Untitled", "general");
              }}
              className="btn-accent rounded-lg px-3 py-1.5 text-[13px]"
            >
              + New
            </button>
          </div>
        )}
      </div>

      {/* Tag Filter (pages tab only) */}
      {tab === "pages" && allTags.length > 0 && (
        <div className="border-b border-border px-3 py-2">
          {tagFilter ? (
            <div className="flex items-center gap-2">
              <span className="text-[12px] text-text-muted">Filter:</span>
              <span className="tag-pill rounded-full bg-accent/10 px-2 py-0.5 text-[12px] font-medium text-accent">
                {tagFilter}
              </span>
              <button
                onClick={() => setTagFilter(null)}
                className="text-[12px] text-text-muted transition-colors hover:text-danger"
              >
                Clear
              </button>
            </div>
          ) : (
            // Cap the tag cloud to ~8 rows and scroll the rest — otherwise a
            // vault with hundreds of tags pushes the page list off-screen.
            <div className="flex max-h-44 flex-wrap gap-1 overflow-y-auto pr-1">
              {allTags.map((tag) => (
                <button
                  key={tag}
                  onClick={() => setTagFilter(tag)}
                  className="tag-pill h-fit rounded-full bg-surface px-2 py-0.5 text-[12px] text-text-muted hover:bg-accent/10 hover:text-accent"
                >
                  {tag}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Bulk action bar */}
      {selectionMode && selectedPaths.size > 0 && (
        <BulkActionBar
          count={selectedPaths.size}
          folders={folders}
          onMove={bulkMove}
          onArchive={bulkArchive}
          onDelete={bulkDelete}
          onCancel={clearSelection}
        />
      )}

      {/* List Content */}
      <div
        data-tour="folders"
        className="flex-1 overflow-y-auto overscroll-contain px-2 py-2"
      >
        {tab === "pages" ? (
          <DndContext
            sensors={sensors}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            {/* Root-level drop zone — visible only while dragging */}
            {draggedItem && <RootDropZone />}
            <div className="space-y-0.5">
              {creatingFolder && <InlineFolderCreate />}
              {folders.length === 0 && sortedPages.length === 0 ? (
                <p className="px-3 py-4 text-center text-sm text-text-muted">
                  {tagFilter
                    ? `No pages with tag "${tagFilter}".`
                    : "No pages yet. Create your first page."}
                </p>
              ) : (
                folderTree.map((node) => (
                  <FolderSection
                    key={node.path}
                    node={node}
                    depth={0}
                    allPagesByFolder={pagesByFolder}
                    allFolders={folders}
                    draggedFolderPath={
                      draggedItem?.type === "folder" ? draggedItem.path : null
                    }
                    onCreatePage={async (f) => {
                      await createPage("Untitled", f);
                    }}
                    renderPage={(page) => (
                      <PageItem
                        key={page.path}
                        page={page}
                        isActive={activePage?.path === page.path}
                        isSelected={selectedPaths.has(page.path)}
                        selectionMode={selectionMode}
                        onClick={() => openPage(page.path)}
                        onSelect={(e) => {
                          if (e?.shiftKey && lastSelectedRef.current) {
                            // Range select within the same folder only
                            const folderPages = sortedPages
                              .filter((p) => p.meta.folder === page.meta.folder)
                              .map((p) => p.path);
                            if (folderPages.includes(lastSelectedRef.current)) {
                              selectRange(
                                lastSelectedRef.current,
                                page.path,
                                folderPages,
                              );
                            } else {
                              toggleSelect(page.path);
                            }
                          } else {
                            toggleSelect(page.path);
                          }
                          lastSelectedRef.current = page.path;
                        }}
                        onTogglePin={() => togglePin(page.path)}
                        onToggleArchive={() => toggleArchive(page.path)}
                        onDelete={() => deletePage(page.path)}
                        onDuplicate={() => duplicatePage(page.path)}
                        folders={folders}
                        onMoveTo={(f) => movePage(page.path, f)}
                        compact={sidebarDensity === "compact"}
                      />
                    )}
                  />
                ))
              )}
            </div>
            {/* Drag overlay — floating preview shown while dragging */}
            <DragOverlay dropAnimation={null}>
              {draggedItem && (
                <div className="flex items-center gap-1.5 rounded-lg border border-accent/40 bg-surface-raised px-3 py-1.5 text-[13px] text-text-primary shadow-lg">
                  {draggedItem.type === "folder" ? (
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 16 16"
                      style={{ color: "#d97706" }}
                    >
                      <path
                        d="M1 3.5A1.5 1.5 0 012.5 2h3.172a1.5 1.5 0 011.06.44l.829.828a.5.5 0 00.354.146H13.5A1.5 1.5 0 0115 4.914V12.5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z"
                        fill="currentColor"
                      />
                    </svg>
                  ) : (
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 16 16"
                      fill="none"
                      className="text-text-muted/60"
                    >
                      <path
                        d="M4.5 1.5h5l3 3v9a1 1 0 01-1 1h-7a1 1 0 01-1-1v-11a1 1 0 011-1z"
                        stroke="currentColor"
                        strokeWidth="1.2"
                      />
                    </svg>
                  )}
                  {draggedItem.label}
                  {draggedItem.count > 1 && (
                    <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-white">
                      {draggedItem.count}
                    </span>
                  )}
                </div>
              )}
            </DragOverlay>
          </DndContext>
        ) : sortedSecrets.length === 0 ? (
          <p className="px-3 py-4 text-center text-sm text-text-muted">
            No secrets yet. Add a secret block to any page.
          </p>
        ) : (
          <div className="space-y-0.5">
            {sortedSecrets.map((secret, i) => (
              <SecretItem
                key={`${secret.page_path}-${secret.label}-${i}`}
                secret={secret}
                onClick={() => openPage(secret.page_path)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Archive toggle */}
      {tab === "pages" && pages.some((p) => p.meta.archived) && (
        <div className="border-t border-border px-3 py-2">
          <button
            onClick={() => setShowArchived(!showArchived)}
            className="flex w-full items-center gap-2 text-[13px] text-text-muted transition-colors hover:text-text-secondary"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <rect
                x="2"
                y="3"
                width="12"
                height="4"
                rx="1"
                stroke="currentColor"
                strokeWidth="1.3"
              />
              <path
                d="M3 7v5a1 1 0 001 1h8a1 1 0 001-1V7"
                stroke="currentColor"
                strokeWidth="1.3"
              />
              <path
                d="M6.5 10h3"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
              />
            </svg>
            {showArchived ? "Hide Archived" : "Show Archived"}
            <span className="ml-auto rounded bg-surface-overlay/60 px-1.5 py-px text-[11px]">
              {pages.filter((p) => p.meta.archived).length}
            </span>
          </button>
        </div>
      )}

      {/* Footer */}
      <div className="sidebar-footer border-t border-border px-2 py-2">
        {/* Row 1: Lock + icon buttons */}
        <div className="flex items-center justify-between">
          <button
            onClick={() => lock("manual")}
            className="group flex items-center gap-1 rounded-lg px-2 py-1 text-[13px] font-medium text-text-muted transition-all hover:bg-danger/10 hover:text-danger active:scale-95"
          >
            <LockClosedIcon
              size={16}
              className="transition-transform group-hover:scale-110"
            />
            Lock
          </button>
          <div className="flex flex-wrap justify-end gap-0">
            {/* 1. Help */}
            <button
              onClick={() => useUIStore.getState().startTour("quick")}
              className="icon-btn p-1 text-text-muted"
              data-tooltip="Help &amp; Getting Started"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.3" />
                <path
                  d="M6 6a2 2 0 013.89.67c0 1.33-2 1.33-2 2.33M8 12h.01"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            {/* 2. Share */}
            <button
              data-tour="sharing"
              onClick={() => setShareModalOpen(true)}
              className="icon-btn p-1 text-text-muted"
              data-tooltip={kbd("Share (Mod+Shift+E)")}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path
                  d="M4 9v4a1 1 0 001 1h6a1 1 0 001-1V9"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M8 10V2M5 5l3-3 3 3"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            {/* 3. Import */}
            <button
              data-tour="import"
              onClick={() => setImportModalOpen(true)}
              className="icon-btn p-1 text-text-muted"
              data-tooltip="Import passwords"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path
                  d="M8 2v8M5 7l3 3 3-3"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M2 12v1a1 1 0 001 1h10a1 1 0 001-1v-1"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            {/* 4. Generator */}
            <button
              data-tour="generator"
              onClick={() => setGeneratorOpen(true)}
              className="icon-btn p-1 text-text-muted"
              data-tooltip={kbd("Generator (Mod+G)")}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <rect
                  x="1.5"
                  y="1.5"
                  width="13"
                  height="13"
                  rx="2"
                  stroke="currentColor"
                  strokeWidth="1.3"
                />
                <circle cx="5" cy="5" r="1" fill="currentColor" />
                <circle cx="11" cy="5" r="1" fill="currentColor" />
                <circle cx="5" cy="11" r="1" fill="currentColor" />
                <circle cx="11" cy="11" r="1" fill="currentColor" />
                <circle cx="8" cy="8" r="1" fill="currentColor" />
              </svg>
            </button>
            {/* 5. Refresh (single, combined) */}
            <button
              onClick={() => {
                loadPages();
                loadSecrets();
                loadFolders();
              }}
              className="icon-btn p-1 text-text-muted"
              data-tooltip="Refresh pages &amp; secrets"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path
                  d="M2 8a6 6 0 0110.47-4M14 8a6 6 0 01-10.47 4"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
                <path
                  d="M13 1v3.5h-3.5M3 15v-3.5h3.5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            {/* 6. Theme (Sun icon) */}
            <button
              onClick={handleThemeCycle}
              className="icon-btn p-1 text-text-muted"
              data-tooltip={`Theme: ${theme}`}
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="5" />
                <line x1="12" y1="1" x2="12" y2="3" />
                <line x1="12" y1="21" x2="12" y2="23" />
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                <line x1="1" y1="12" x2="3" y2="12" />
                <line x1="21" y1="12" x2="23" y2="12" />
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
              </svg>
            </button>
            {/* 7. Settings (Gear icon) */}
            <button
              onClick={() => setSettingsOpen(true)}
              className="icon-btn p-1 text-text-muted"
              data-tooltip={kbd("Settings (Mod+,)")}
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" />
              </svg>
            </button>
          </div>
        </div>
        <ShareBadge />
        {/* License status */}
        {licenseStatus && (
          <div className="flex items-center gap-1.5 px-1 py-0.5">
            <span
              className={`inline-flex items-center rounded px-1.5 py-px text-[10px] font-semibold leading-tight ${
                licenseStatus.is_pro && !licenseStatus.is_expired
                  ? "bg-success/15 text-success"
                  : "bg-text-muted/15 text-text-muted"
              }`}
            >
              {licenseStatus.is_trial
                ? "Trial"
                : licenseStatus.tier === "pro_plus"
                  ? "Pro+"
                  : licenseStatus.tier === "pro"
                    ? "Pro"
                    : "Free"}
            </span>
            {licenseStatus.email && (
              <span
                className="truncate text-[10px] text-text-muted"
                title={licenseStatus.email}
              >
                {licenseStatus.email}
              </span>
            )}
          </div>
        )}
        {/* Row 2: Sync + version inline */}
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <SyncStatusBar />
          </div>
          <span className="shrink-0 text-[11px] tracking-wider text-text-muted/60">
            v{VERSION_DISPLAY}
          </span>
        </div>
      </div>
    </div>
  );
}
