// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * PreviewContextMenu — right-click menu for the rendered markdown preview pane.
 *
 * Attaches a `contextmenu` listener to the given container and shows a small
 * fixed-positioned menu offering Copy (selection) and Select All. Distinct
 * from the editor's context menu, which operates on the CodeMirror instance.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { copyToClipboard } from "@/lib/clipboard";

interface MenuPosition {
  x: number;
  y: number;
}

interface PreviewContextMenuProps {
  containerRef: React.RefObject<HTMLDivElement | null>;
}

/** Right-click menu bound to the markdown preview container. */
export function PreviewContextMenu({ containerRef }: PreviewContextMenuProps) {
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const [hasSelection, setHasSelection] = useState(false);
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
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (x !== position.x || y !== position.y) setPosition({ x, y });
  }, [position]);

  if (!position) return null;

  // Handlers are referenced directly by each button's onClick (not collected
  // into an array that is mapped during render), so reading containerRef.current
  // here stays outside render.
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
      <button
        onClick={handleCopy}
        disabled={!hasSelection}
        className="flex w-full items-center justify-between px-3 py-1.5 text-[13px] text-text-primary transition-colors hover:bg-accent/10 disabled:opacity-40 disabled:hover:bg-transparent"
      >
        <span>Copy</span>
        <span className="ml-6 text-[11px] text-text-muted">{`${mod}C`}</span>
      </button>
      <button
        onClick={handleSelectAll}
        className="flex w-full items-center justify-between px-3 py-1.5 text-[13px] text-text-primary transition-colors hover:bg-accent/10 disabled:opacity-40 disabled:hover:bg-transparent"
      >
        <span>Select All</span>
        <span className="ml-6 text-[11px] text-text-muted">{`${mod}A`}</span>
      </button>
    </div>
  );
}
