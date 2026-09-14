// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Read-only side-by-side diff of two markdown documents (local vs. remote),
 * built on CodeMirror's MergeView. Used by the conflict resolver to preview
 * differences before the user picks a resolution.
 */
import { useEffect, useRef } from "react";
import { MergeView } from "@codemirror/merge";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { clasptTheme } from "./editor/theme";

interface DiffMergeViewProps {
  localContent: string;
  remoteContent: string;
  height?: number;
}

/** Renders a read-only two-pane CodeMirror merge view of local vs. remote content. */
export function DiffMergeView({
  localContent,
  remoteContent,
  height = 400,
}: DiffMergeViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<MergeView | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const shared = [
      markdown(),
      ...clasptTheme,
      EditorView.editable.of(false),
      EditorState.readOnly.of(true),
    ];

    const view = new MergeView({
      a: { doc: localContent, extensions: shared },
      b: { doc: remoteContent, extensions: shared },
      parent: containerRef.current,
      highlightChanges: true,
      gutter: true,
      collapseUnchanged: { margin: 3, minSize: 4 },
    });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [localContent, remoteContent]);

  return (
    <div className="diff-merge-view overflow-hidden rounded-lg border border-border/60">
      <div className="flex border-b border-border/40 text-[11px] font-medium text-text-muted">
        <div className="flex-1 px-3 py-1.5">Local</div>
        <div className="flex-1 border-l border-border/40 px-3 py-1.5">Remote</div>
      </div>
      <div ref={containerRef} style={{ height, overflow: "auto" }} />
    </div>
  );
}
