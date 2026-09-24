// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import type { EditorView } from "@codemirror/view";
import { attachmentMarkdown } from "@/lib/attachments";

/** Module-level ref to the active EditorView for programmatic inserts. */
let activeView: EditorView | null = null;

export function setActiveView(view: EditorView | null) {
  activeView = view;
}

export function getActiveView(): EditorView | null {
  return activeView;
}

/** Insert text at the current cursor position in the active editor. */
export function insertAtCursor(text: string) {
  if (!activeView) return;
  const { from } = activeView.state.selection.main;
  activeView.dispatch({
    changes: { from, insert: text },
    selection: { anchor: from + text.length },
  });
  activeView.focus();
}

/** Wrap the current selection with prefix/suffix, or insert placeholder. */
export function wrapSelection(prefix: string, suffix: string, placeholder: string) {
  if (!activeView) return;
  const { from, to } = activeView.state.selection.main;
  const selected = activeView.state.sliceDoc(from, to);

  if (selected) {
    activeView.dispatch({
      changes: { from, to, insert: `${prefix}${selected}${suffix}` },
      selection: {
        anchor: from + prefix.length,
        head: from + prefix.length + selected.length,
      },
    });
  } else {
    activeView.dispatch({
      changes: { from, insert: `${prefix}${placeholder}${suffix}` },
      selection: {
        anchor: from + prefix.length,
        head: from + prefix.length + placeholder.length,
      },
    });
  }
  activeView.focus();
}

/** Insert an image markdown reference at the cursor. */
export function insertImageMarkdown(altText: string, mdPath: string, comment = "") {
  insertAtCursor(`${attachmentMarkdown(altText, mdPath, comment)}\n`);
}

/** Insert prefix at the start of the current line. */
export function prefixLine(prefix: string) {
  if (!activeView) return;
  const { from } = activeView.state.selection.main;
  const line = activeView.state.doc.lineAt(from);

  // Toggle: if already prefixed, remove it
  if (line.text.startsWith(prefix)) {
    activeView.dispatch({
      changes: { from: line.from, to: line.from + prefix.length, insert: "" },
    });
  } else {
    activeView.dispatch({
      changes: { from: line.from, insert: prefix },
    });
  }
  activeView.focus();
}
