// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * EditorContextMenu — right-click menu for the CodeMirror editor.
 *
 * Bound to the editor container, it offers standard edit actions (undo/redo,
 * cut/copy/paste, select all, find) that operate on the active CodeMirror
 * view, plus a "Convert to Secret(s)" action that turns the selected text
 * into secret blocks (suggesting a label from the nearest heading above the
 * cursor) via {@link ConvertToSecretModal}.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { undo, redo, selectAll } from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";
import { getActiveView } from "./editor-api";
import { ConvertToSecretModal } from "./ConvertToSecretModal";
import { copyToClipboard, readFromClipboard } from "@/lib/clipboard";

interface MenuPosition {
  x: number;
  y: number;
}

interface MenuItem {
  label: string;
  shortcut?: string;
  action: () => void;
  disabled?: boolean;
  separator?: false;
  accent?: boolean;
}

interface MenuSeparator {
  separator: true;
}

type MenuEntry = MenuItem | MenuSeparator;

interface EditorContextMenuProps {
  containerRef: React.RefObject<HTMLDivElement | null>;
}

/** Right-click editing menu bound to the CodeMirror editor container. */
export function EditorContextMenu({ containerRef }: EditorContextMenuProps) {
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const [hasSelection, setHasSelection] = useState(false);
  const [convertModal, setConvertModal] = useState<{
    text: string;
    label: string;
    from: number;
    to: number;
  } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const isMac = navigator.platform.includes("Mac");
  const mod = isMac ? "⌘" : "Ctrl+";

  const close = useCallback(() => setPosition(null), []);

  // Show menu on right-click inside the editor container
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    function onContextMenu(e: MouseEvent) {
      e.preventDefault();
      e.stopPropagation();
      const view = getActiveView();
      setHasSelection(view ? !view.state.selection.main.empty : false);
      setPosition({ x: e.clientX, y: e.clientY });
    }

    el.addEventListener("contextmenu", onContextMenu);
    return () => el.removeEventListener("contextmenu", onContextMenu);
  }, [containerRef]);

  // Close on click outside, escape, or scroll
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

  // Adjust position to keep menu within viewport
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

  const handlePaste = useCallback(async () => {
    const view = getActiveView();
    if (!view) {
      close();
      return;
    }
    try {
      const text = await readFromClipboard();
      const { from, to } = view.state.selection.main;
      view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
      });
    } catch {
      view.focus();
      document.execCommand("paste");
    }
    close();
  }, [close]);

  /** Get the nearest heading above the cursor for label suggestion. */
  function suggestLabel(): string {
    const view = getActiveView();
    if (!view) return "Credentials";
    const { from } = view.state.selection.main;
    const doc = view.state.doc;
    // Walk backwards from selection to find nearest ## or ### heading
    for (let line = doc.lineAt(from).number; line >= 1; line--) {
      const text = doc.line(line).text;
      const match = text.match(/^#{1,3}\s+(.+)/);
      if (match?.[1]) {
        return match[1].trim();
      }
    }
    return "Credentials";
  }

  const handleConvertToSecret = useCallback(() => {
    const view = getActiveView();
    if (!view) {
      close();
      return;
    }
    const { from, to } = view.state.selection.main;
    const text = view.state.sliceDoc(from, to);
    const label = suggestLabel();
    setConvertModal({ text, label, from, to });
    close();
  }, [close]);

  const handleConvertComplete = useCallback(
    (secretBlocks: string) => {
      if (!convertModal) return;
      const view = getActiveView();
      if (!view) return;
      const { from, to } = convertModal;
      view.dispatch({
        changes: { from, to, insert: secretBlocks },
        selection: { anchor: from + secretBlocks.length },
      });
      view.focus();
      setConvertModal(null);
    },
    [convertModal],
  );

  const items: MenuEntry[] = [
    {
      label: "Undo",
      shortcut: `${mod}Z`,
      action: () => {
        const v = getActiveView();
        if (v) {
          undo(v);
          v.focus();
        }
        close();
      },
    },
    {
      label: "Redo",
      shortcut: isMac ? "⇧⌘Z" : "Ctrl+Y",
      action: () => {
        const v = getActiveView();
        if (v) {
          redo(v);
          v.focus();
        }
        close();
      },
    },
    { separator: true },
    {
      label: "Cut",
      shortcut: `${mod}X`,
      disabled: !hasSelection,
      action: () => {
        const v = getActiveView();
        if (v) {
          const { from, to } = v.state.selection.main;
          const text = v.state.sliceDoc(from, to);
          copyToClipboard(text);
          v.dispatch({ changes: { from, to, insert: "" } });
          v.focus();
        }
        close();
      },
    },
    {
      label: "Copy",
      shortcut: `${mod}C`,
      disabled: !hasSelection,
      action: () => {
        const v = getActiveView();
        if (v) {
          const { from, to } = v.state.selection.main;
          copyToClipboard(v.state.sliceDoc(from, to));
          v.focus();
        }
        close();
      },
    },
    {
      label: "Paste",
      shortcut: `${mod}V`,
      action: handlePaste,
    },
    { separator: true },
    {
      label: "Convert to Secret(s)",
      disabled: !hasSelection,
      action: handleConvertToSecret,
      accent: true,
    },
    { separator: true },
    {
      label: "Select All",
      shortcut: `${mod}A`,
      action: () => {
        const v = getActiveView();
        if (v) {
          selectAll(v);
          v.focus();
        }
        close();
      },
    },
    { separator: true },
    {
      label: "Find in Page",
      shortcut: `${mod}F`,
      action: () => {
        const v = getActiveView();
        if (v) openSearchPanel(v);
        close();
      },
    },
  ];

  return (
    <>
      {position && (
        <div
          ref={menuRef}
          className="fixed z-[100] min-w-[200px] rounded-lg border border-border bg-surface py-1 shadow-xl"
          style={{ left: position.x, top: position.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {items.map((item, i) =>
            item.separator ? (
              <div key={i} className="my-1 border-t border-border/50" />
            ) : (
              <button
                key={item.label}
                onClick={item.action}
                disabled={item.disabled}
                className={`flex w-full items-center justify-between px-3 py-1.5 text-[13px] transition-colors disabled:opacity-40 disabled:hover:bg-transparent ${
                  item.accent
                    ? "text-accent hover:bg-accent/10 font-medium"
                    : "text-text-primary hover:bg-accent/10"
                }`}
              >
                <span className="flex items-center gap-2">
                  {item.accent && (
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 16 16"
                      fill="none"
                      className="shrink-0"
                    >
                      <path
                        d="M8 1v4M8 11v4M1 8h4M11 8h4"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                      />
                    </svg>
                  )}
                  {item.label}
                </span>
                {item.shortcut && (
                  <span className="ml-6 text-[11px] text-text-muted">
                    {item.shortcut}
                  </span>
                )}
              </button>
            ),
          )}
        </div>
      )}

      {convertModal && (
        <ConvertToSecretModal
          selectedText={convertModal.text}
          suggestedLabel={convertModal.label}
          onConvert={handleConvertComplete}
          onClose={() => setConvertModal(null)}
        />
      )}
    </>
  );
}
