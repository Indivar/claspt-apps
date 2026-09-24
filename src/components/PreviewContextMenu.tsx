// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * PreviewContextMenu — right-click menu for the rendered markdown preview pane.
 *
 * Attaches a `contextmenu` listener to the given container and shows a small
 * fixed-positioned menu offering Copy (selection) and Select All. On an
 * attachment it also offers to encrypt or unencrypt the file, save a copy
 * outside the vault, show it in the file manager, or delete it. Distinct
 * from the editor's context menu, which operates on the CodeMirror instance.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { copyToClipboard } from "@/lib/clipboard";
import { errorMessage } from "@/lib/error-message";
import { exportMedia, resolveMediaPath, setMediaSealed } from "@/lib/commands";
import { formatSize } from "@/lib/attachments";
import { attachmentAt, type AttachmentTarget } from "@/lib/preview-attachments";
import { DeleteAttachmentDialog } from "@/components/DeleteAttachmentDialog";

interface MenuPosition {
  x: number;
  y: number;
}

interface PreviewContextMenuProps {
  containerRef: React.RefObject<HTMLDivElement | null>;
  folder: string;
  content: string;
  onContentChange?: (content: string) => Promise<void>;
  /** Called after an attachment changed on disk, so the preview resolves it again. */
  onAttachmentChanged: () => void;
}

const ITEM_CLASS =
  "flex w-full items-center justify-between px-3 py-1.5 text-[13px] text-text-primary transition-colors hover:bg-accent/10 disabled:opacity-40 disabled:hover:bg-transparent";

/** Right-click menu bound to the markdown preview container. */
export function PreviewContextMenu({
  containerRef,
  folder,
  content,
  onContentChange,
  onAttachmentChanged,
}: PreviewContextMenuProps) {
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const [hasSelection, setHasSelection] = useState(false);
  const [attachment, setAttachment] = useState<AttachmentTarget | null>(null);
  const [deleting, setDeleting] = useState<AttachmentTarget | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const isMac = navigator.platform.includes("Mac");
  const mod = isMac ? "⌘" : "Ctrl+";

  const close = useCallback(() => setPosition(null), []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    function onContextMenu(e: MouseEvent) {
      e.preventDefault();
      e.stopPropagation();
      const sel = window.getSelection();
      setHasSelection(!!sel && sel.toString().length > 0);
      setAttachment(attachmentAt(e.target));
      setPosition({ x: e.clientX, y: e.clientY });
    }

    el.addEventListener("contextmenu", onContextMenu);
    return () => el.removeEventListener("contextmenu", onContextMenu);
  }, [containerRef]);

  useEffect(() => {
    if (!position) return;
    function onClose() {
      setPosition(null);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setPosition(null);
    }
    document.addEventListener("mousedown", onClose);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onClose, true);
    return () => {
      document.removeEventListener("mousedown", onClose);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [position]);

  useEffect(() => {
    if (!position || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    let { x, y } = position;
    if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 8;
    if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 8;
    // Reposition based on the menu's measured size once it has rendered — a
    // post-render DOM measurement that cannot be derived during render. The
    // equality guard prevents a re-render loop.
    if (x !== position.x || y !== position.y) setPosition({ x, y });
  }, [position]);

  if (deleting) {
    return (
      <DeleteAttachmentDialog
        attachment={deleting}
        folder={folder}
        content={content}
        onContentChange={onContentChange}
        onDeleted={onAttachmentChanged}
        onClose={() => setDeleting(null)}
      />
    );
  }

  if (!position) return null;

  // Handlers are referenced directly by each button's onClick (not collected
  // into an array that is mapped during render), so reading containerRef.current
  // here stays outside render.
  const handleToggleSeal = async () => {
    const target = attachment;
    close();
    if (!target) return;
    try {
      await setMediaSealed(target.relPath, !target.sealed);
      toast.success(
        target.sealed
          ? `${target.name} is no longer encrypted`
          : `${target.name} is now encrypted`,
      );
      onAttachmentChanged();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const handleSaveCopy = async () => {
    const target = attachment;
    close();
    if (!target) return;
    const dest = await save({ defaultPath: target.name, title: "Save a copy" });
    if (!dest) return;
    try {
      await exportMedia(target.relPath, dest);
      toast.success(`Saved a copy of ${target.name}`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const handleReveal = async () => {
    const target = attachment;
    close();
    if (!target) return;
    try {
      await revealItemInDir(await resolveMediaPath(folder, target.mdPath));
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const handleDelete = () => {
    const target = attachment;
    close();
    if (target) setDeleting(target);
  };

  const handleCopy = () => {
    const sel = window.getSelection();
    if (sel) copyToClipboard(sel.toString());
    close();
  };

  const handleSelectAll = () => {
    const el = containerRef.current;
    if (el) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
    close();
  };

  return (
    <div
      ref={menuRef}
      className="fixed z-[100] min-w-[160px] rounded-lg border border-border bg-surface py-1 shadow-xl"
      style={{ left: position.x, top: position.y }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {attachment && (
        <>
          <div className="px-3 pb-1 pt-1.5">
            <div
              className="truncate text-[12px] font-medium text-text-primary"
              title={attachment.name}
            >
              {attachment.name}
            </div>
            <div className="text-[11px] text-text-muted">
              {formatSize(attachment.size)}
              {attachment.sealed ? " · encrypted" : ""}
            </div>
          </div>
          <button onClick={handleToggleSeal} className={ITEM_CLASS}>
            <span>
              {attachment.sealed ? "Remove encryption" : "Encrypt this attachment"}
            </span>
          </button>
          <button onClick={handleSaveCopy} className={ITEM_CLASS}>
            <span>Save a copy…</span>
          </button>
          <button onClick={handleReveal} className={ITEM_CLASS}>
            <span>{isMac ? "Show in Finder" : "Show in folder"}</span>
          </button>
          <button onClick={handleDelete} className={`${ITEM_CLASS} text-danger`}>
            <span>Delete attachment…</span>
          </button>
          <div className="my-1 h-px bg-border" />
        </>
      )}
      <button onClick={handleCopy} disabled={!hasSelection} className={ITEM_CLASS}>
        <span>Copy</span>
        <span className="ml-6 text-[11px] text-text-muted">{`${mod}C`}</span>
      </button>
      <button onClick={handleSelectAll} className={ITEM_CLASS}>
        <span>Select All</span>
        <span className="ml-6 text-[11px] text-text-muted">{`${mod}A`}</span>
      </button>
    </div>
  );
}
