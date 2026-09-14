// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * FolderSection — a single recursive node in the sidebar folder tree.
 *
 * Renders a collapsible folder header (with drag-to-move, drop-target, rename,
 * new-page/new-subfolder, and a right-click context menu) plus its nested child
 * folders and the pages that live directly inside it. Drag/drop is powered by
 * @dnd-kit; the context menu and delete dialog are portalled to document.body so
 * the sidebar's overflow clipping and stacking context don't cut them off.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { usePagesStore } from "@/stores/pages-store";
import { useUIStore } from "@/stores/ui-store";
import { useClickOutside } from "@/hooks/use-click-outside";
import type { PageSummary } from "@claspt/shared/types";
import type { FolderNode } from "./folder-tree";

interface FolderSectionProps {
  /** The folder tree node to render (name, path, and child folders). */
  node: FolderNode;
  /** Nesting depth, used to compute indentation (capped at 5 levels). */
  depth: number;
  /** Map of folder path → pages living directly in that folder. */
  allPagesByFolder: Record<string, PageSummary[]>;
  /** Renders a single page row; supplied by the parent so the sidebar owns page UI. */
  renderPage: (page: PageSummary) => React.ReactNode;
  /** Optional callback to create a new page in the given folder. */
  onCreatePage?: (folder: string) => void;
  /** Every folder path in the vault, used for move targets and recursive page counts. */
  allFolders: string[];
  /** The folder path currently being dragged (null if none). Used to prevent invalid drops. */
  draggedFolderPath?: string | null;
}

/**
 * Renders one folder row and, when expanded, its subfolders and pages recursively.
 * The "general" folder is treated as the immutable default (not draggable/renamable/deletable).
 */
export function FolderSection({
  node,
  depth,
  allPagesByFolder,
  renderPage,
  onCreatePage,
  allFolders,
  draggedFolderPath,
}: FolderSectionProps) {
  const { collapsedFolders, toggleFolderCollapsed, renamingFolder, setRenamingFolder } =
    useUIStore();
  const { deleteFolder } = usePagesStore();
  const pages = allPagesByFolder[node.path] ?? [];
  const collapsed = !!collapsedFolders[node.path];
  const isDefault = node.path === "general";
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 });
  const [moveMenuOpen, setMoveMenuOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [renameValue, setRenameValue] = useState(node.name);
  const [creatingSubfolder, setCreatingSubfolder] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);

  const isRenaming = renamingFolder === node.path;

  // @dnd-kit droppable — this folder is a drop target for pages and other folders.
  // Dropping a folder onto itself or one of its own descendants would create a cycle,
  // so those targets are disabled.
  const isInvalidDropTarget =
    draggedFolderPath != null &&
    (draggedFolderPath === node.path || node.path.startsWith(draggedFolderPath + "/"));
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `folder:${node.path}`,
    data: { type: "folder", path: node.path },
    disabled: isInvalidDropTarget,
  });
  const showDropHighlight = isOver && !isInvalidDropTarget;

  // @dnd-kit draggable — this folder can be dragged to another folder (except "general")
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({
    id: `folder-drag:${node.path}`,
    data: { type: "folder", path: node.path },
    disabled: isDefault || isRenaming,
  });
  // Combine droppable + draggable refs on the same element
  const combinedRef = useCallback(
    (el: HTMLDivElement | null) => {
      setDropRef(el);
      setDragRef(el);
    },
    [setDropRef, setDragRef],
  );

  useEffect(() => {
    if (isRenaming && renameRef.current) {
      renameRef.current.focus();
      renameRef.current.select();
    }
  }, [isRenaming]);

  useClickOutside(
    menuRef,
    () => {
      setMenuOpen(false);
      setMoveMenuOpen(false);
    },
    menuOpen,
  );

  const handleRenameSubmit = async () => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== node.name) {
      const segments = node.path.split("/");
      segments[segments.length - 1] = trimmed;
      const newPath = segments.join("/");
      await usePagesStore.getState().renameFolder(node.path, newPath);
    }
    setRenamingFolder(null);
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleRenameSubmit();
    } else if (e.key === "Escape") {
      setRenameValue(node.name);
      setRenamingFolder(null);
    }
  };

  // Count all pages in this folder AND its descendants
  const totalPageCount = allFolders
    .filter((f) => f === node.path || f.startsWith(node.path + "/"))
    .reduce((sum, f) => sum + (allPagesByFolder[f]?.length ?? 0), 0);

  const handleDelete = async (action: string) => {
    await deleteFolder(node.path, action);
    setDeleteDialogOpen(false);
  };

  // Move folder to another folder via context menu
  const handleMoveFolder = async (targetFolder: string) => {
    const folderName = node.path.split("/").pop()!;
    const newPath = `${targetFolder}/${folderName}`;
    setMenuOpen(false);
    setMoveMenuOpen(false);
    await usePagesStore.getState().renameFolder(node.path, newPath);
  };

  // Indent based on depth, cap at 5 levels
  const indent = Math.min(depth, 5);

  // Folders to exclude: self + descendants (used for delete dialog and move menu)
  const excludedFolders = allFolders.filter(
    (f) => f !== node.path && !f.startsWith(node.path + "/"),
  );
  // Also exclude current parent from move targets
  const currentParent = node.path.includes("/")
    ? node.path.substring(0, node.path.lastIndexOf("/"))
    : null;
  const moveTargets = excludedFolders.filter((f) => f !== currentParent);
  const deleteMoveTargets = excludedFolders;

  const openMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (isDefault) return;
    const x = Math.min(e.clientX, window.innerWidth - 200);
    const y = Math.min(e.clientY, window.innerHeight - 260);
    setMenuPos({ x, y });
    setMenuOpen(true);
    setMoveMenuOpen(false);
  };

  return (
    <div>
      {/* Folder Header */}
      <div
        ref={combinedRef}
        {...listeners}
        {...attributes}
        data-tour={node.path === "help" ? "help-folder" : undefined}
        className={`group relative flex h-[22px] items-center gap-1 pr-2 transition-colors ${
          showDropHighlight
            ? "bg-accent/15 ring-1 ring-accent/40"
            : "hover:bg-surface-overlay/40"
        } ${isDragging ? "opacity-40" : ""}`}
        style={{ paddingLeft: `${4 + indent * 16}px` }}
        onContextMenu={openMenu}
      >
        {/* Collapse toggle */}
        <button
          onClick={() => toggleFolderCollapsed(node.path)}
          className="flex h-4 w-4 shrink-0 items-center justify-center text-text-muted/70"
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 16 16"
            fill="currentColor"
            className={`transition-transform ${collapsed ? "" : "rotate-90"}`}
          >
            <path d="M6 3l5 5-5 5z" />
          </svg>
        </button>

        {/* Folder icon — amber to distinguish from document icons */}
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          className="shrink-0"
          style={{ color: "var(--color-folder-icon, #d97706)" }}
        >
          <path
            d="M1 3.5A1.5 1.5 0 012.5 2h3.172a1.5 1.5 0 011.06.44l.829.828a.5.5 0 00.354.146H13.5A1.5 1.5 0 0115 4.914V12.5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z"
            fill="currentColor"
            opacity="0.8"
          />
        </svg>

        {/* Folder name or rename input */}
        {isRenaming ? (
          <input
            ref={renameRef}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={handleRenameKeyDown}
            onBlur={handleRenameSubmit}
            className="min-w-0 flex-1 rounded border border-accent bg-surface px-1 py-0 text-[13px] text-text-primary outline-none"
          />
        ) : (
          <button
            onClick={() => toggleFolderCollapsed(node.path)}
            className="min-w-0 truncate text-left text-[13px] text-text-secondary"
          >
            {node.name}
          </button>
        )}

        <div className="min-w-0 flex-1" />

        {/* Page count badge — hidden on hover to make room for action buttons */}
        <span className="flex h-[16px] min-w-[16px] shrink-0 items-center justify-center rounded-full bg-surface-overlay/60 px-1 text-[10px] font-medium text-text-muted/70 group-hover:invisible">
          {totalPageCount}
        </span>

        {/* Hover action buttons — overlay the badge area on hover */}
        <div className="absolute right-2 flex shrink-0 items-center gap-0 opacity-0 group-hover:opacity-100">
          {/* New subfolder button */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              setCreatingSubfolder(true);
              if (collapsed) toggleFolderCollapsed(node.path);
            }}
            title={`New subfolder in ${node.path}`}
            className="flex h-[18px] w-[18px] items-center justify-center rounded text-text-muted/70 transition-colors hover:bg-surface-overlay hover:text-text-secondary"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M1 3.5A1.5 1.5 0 012.5 2h3.172a1.5 1.5 0 011.06.44l.829.828a.5.5 0 00.354.146H13.5A1.5 1.5 0 0115 4.914V12.5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z" />
              <path
                d="M8 7v4M6 9h4"
                stroke="white"
                strokeWidth="1.3"
                strokeLinecap="round"
              />
            </svg>
          </button>

          {/* New page button */}
          {onCreatePage && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onCreatePage(node.path);
              }}
              title={`New page in ${node.path}`}
              className="flex h-[18px] w-[18px] items-center justify-center rounded text-text-muted/70 transition-colors hover:bg-surface-overlay hover:text-text-secondary"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 2.5a.5.5 0 01.5.5v4.5H13a.5.5 0 010 1H8.5V13a.5.5 0 01-1 0V8.5H3a.5.5 0 010-1h4.5V3a.5.5 0 01.5-.5z" />
              </svg>
            </button>
          )}

          {/* Context menu trigger */}
          {!isDefault && !isRenaming && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (menuOpen) {
                  setMenuOpen(false);
                } else {
                  openMenu(e);
                }
              }}
              className="flex h-[18px] w-[18px] items-center justify-center rounded text-text-muted/70 transition-colors hover:bg-surface-overlay hover:text-text-secondary"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                <circle cx="4" cy="8" r="1.2" />
                <circle cx="8" cy="8" r="1.2" />
                <circle cx="12" cy="8" r="1.2" />
              </svg>
            </button>
          )}
        </div>

        {/* Context menu — portal to body to avoid sidebar overflow clipping */}
        {menuOpen &&
          createPortal(
            <div
              ref={menuRef}
              style={{ left: menuPos.x, top: menuPos.y }}
              className="fixed z-[100] min-w-44 rounded-lg border border-border bg-surface-raised py-1 shadow-lg"
            >
              <button
                onClick={() => {
                  setMenuOpen(false);
                  setRenameValue(node.name);
                  setRenamingFolder(node.path);
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-text-secondary hover:bg-surface-overlay"
              >
                Rename
              </button>
              <button
                onClick={() => {
                  setMenuOpen(false);
                  setCreatingSubfolder(true);
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-text-secondary hover:bg-surface-overlay"
              >
                New Subfolder
              </button>

              {/* Move to... submenu */}
              {moveTargets.length > 0 && (
                <div className="relative">
                  <button
                    onClick={() => setMoveMenuOpen(!moveMenuOpen)}
                    className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[13px] text-text-secondary hover:bg-surface-overlay"
                  >
                    Move to...
                    <svg width="8" height="8" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M6 3l5 5-5 5z" />
                    </svg>
                  </button>
                  {moveMenuOpen && (
                    <div className="absolute left-full top-0 z-[101] ml-1 max-h-60 min-w-40 overflow-y-auto rounded-lg border border-border bg-surface-raised py-1 shadow-lg">
                      {moveTargets.map((f) => {
                        const d = f.split("/").length - 1;
                        const label = "\u00A0\u00A0".repeat(d) + f.split("/").pop();
                        return (
                          <button
                            key={f}
                            onClick={() => handleMoveFolder(f)}
                            className="flex w-full items-center px-3 py-1.5 text-left text-[13px] text-text-secondary hover:bg-surface-overlay"
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              <div className="my-1 border-t border-border/40" />
              <button
                onClick={() => {
                  setMenuOpen(false);
                  if (totalPageCount === 0) {
                    handleDelete("delete_pages");
                  } else {
                    setDeleteDialogOpen(true);
                  }
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-danger hover:bg-danger/10"
              >
                Delete Folder
              </button>
            </div>,
            document.body,
          )}
      </div>

      {/* Children (sub-folders + pages) — with indent guide line */}
      {!collapsed && (
        <div className="relative">
          {/* VS Code-style indent guide */}
          <div
            className="absolute top-0 bottom-0 w-px bg-border/30"
            style={{ left: `${12 + indent * 16}px` }}
          />

          {/* Inline subfolder creation */}
          {creatingSubfolder && (
            <InlineSubfolderCreate
              parentPath={node.path}
              depth={depth + 1}
              onDone={() => setCreatingSubfolder(false)}
            />
          )}

          {/* Render child folder nodes recursively */}
          {node.children.map((child) => (
            <FolderSection
              key={child.path}
              node={child}
              depth={depth + 1}
              allPagesByFolder={allPagesByFolder}
              renderPage={renderPage}
              onCreatePage={onCreatePage}
              allFolders={allFolders}
              draggedFolderPath={draggedFolderPath}
            />
          ))}

          {/* Pages directly in this folder */}
          <div style={{ paddingLeft: `${4 + (indent + 1) * 16 + 20}px` }}>
            {pages.length === 0 && node.children.length === 0 ? (
              <div className="flex h-[22px] items-center px-2 text-[13px] italic text-text-muted/60">
                No pages
              </div>
            ) : (
              pages.map((page) => renderPage(page))
            )}
          </div>
        </div>
      )}

      {/* Delete Folder Dialog — portal to document root to escape sidebar overflow/stacking */}
      {deleteDialogOpen && (
        <DeleteFolderDialog
          folderPath={node.path}
          totalPageCount={totalPageCount}
          hasChildren={node.children.length > 0}
          moveTargets={deleteMoveTargets}
          onDelete={handleDelete}
          onClose={() => setDeleteDialogOpen(false)}
        />
      )}
    </div>
  );
}

/** Inline input for creating a subfolder within a parent folder. */
function InlineSubfolderCreate({
  parentPath,
  depth,
  onDone,
}: {
  parentPath: string;
  depth: number;
  onDone: () => void;
}) {
  const [value, setValue] = useState("");
  const { createFolder } = usePagesStore();
  const inputRef = useRef<HTMLInputElement>(null);
  const indent = Math.min(depth, 5);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = async () => {
    const trimmed = value.trim();
    if (trimmed) {
      await createFolder(`${parentPath}/${trimmed}`);
    }
    onDone();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSubmit();
    } else if (e.key === "Escape") {
      onDone();
    }
  };

  return (
    <div
      className="flex h-[22px] items-center gap-1 pr-2"
      style={{ paddingLeft: `${4 + indent * 16}px` }}
    >
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
        placeholder="Subfolder name..."
        className="min-w-0 flex-1 rounded border border-accent bg-surface px-1 py-0 text-[13px] text-text-primary outline-none"
      />
    </div>
  );
}

/** Standalone delete folder dialog — rendered via portal to escape sidebar stacking context. */
function DeleteFolderDialog({
  folderPath,
  totalPageCount,
  hasChildren,
  moveTargets,
  onDelete,
  onClose,
}: {
  folderPath: string;
  totalPageCount: number;
  hasChildren: boolean;
  moveTargets: string[];
  onDelete: (action: string) => Promise<void>;
  onClose: () => void;
}) {
  const [moveTarget, setMoveTarget] = useState(moveTargets[0] ?? "general");
  const [busy, setBusy] = useState(false);

  const handleAction = async (action: string) => {
    setBusy(true);
    await onDelete(action);
    setBusy(false);
    onClose();
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50"
      onMouseDown={(e) => {
        // Close on backdrop click (not on dialog card click)
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="mx-4 w-full max-w-sm rounded-xl border border-border bg-surface-raised p-5 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-bold text-text-primary">
          Delete &quot;{folderPath}&quot;?
        </h3>
        <p className="mt-2 text-[13px] text-text-muted">
          This folder contains {totalPageCount} page{totalPageCount !== 1 ? "s" : ""}.
          {hasChildren && " All sub-folders will also be deleted."} What would you like to
          do?
        </p>

        <div className="mt-4 space-y-2">
          <div className="flex items-center gap-2">
            <button
              disabled={busy}
              onClick={() => handleAction(`move_pages:${moveTarget}`)}
              className="btn-accent flex-1 rounded-lg px-3 py-2 text-[13px] font-medium disabled:opacity-50"
            >
              {busy ? "Working..." : "Move pages to:"}
            </button>
            <select
              value={moveTarget}
              onChange={(e) => setMoveTarget(e.target.value)}
              className="rounded-lg border border-border bg-surface px-2 py-2 text-[13px] text-text-secondary outline-none"
            >
              {moveTargets.map((f) => {
                const d = f.split("/").length - 1;
                const label = "\u00A0\u00A0".repeat(d) + f.split("/").pop();
                return (
                  <option key={f} value={f}>
                    {label}
                  </option>
                );
              })}
            </select>
          </div>

          <button
            disabled={busy}
            onClick={() => handleAction("delete_pages")}
            className="w-full rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-[13px] font-medium text-danger transition-colors hover:bg-danger/15 disabled:opacity-50"
          >
            {busy ? "Deleting..." : "Delete all pages"}
          </button>

          <button
            disabled={busy}
            onClick={onClose}
            className="w-full rounded-lg px-3 py-2 text-[13px] text-text-muted transition-colors hover:bg-surface-overlay"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
