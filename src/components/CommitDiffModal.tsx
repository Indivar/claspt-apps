// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * CommitDiffModal — shows the diff for a single page at a specific git commit,
 * comparing the parent revision against the committed revision in a read-only
 * CodeMirror unified merge view. Optionally lets the user restore the page to
 * that commit. Secret values are stripped before display so ciphertext never
 * appears in the diff.
 */
import { useEffect, useRef, useState } from "react";
import { errorMessage } from "@/lib/error-message";
import { unifiedMergeView } from "@codemirror/merge";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { clasptTheme } from "./editor/theme";
import * as cmd from "@/lib/commands";
import { formatDate } from "@/lib/format-date";
import { stripSecretValues } from "@/lib/strip-secrets";
import { CloseIcon } from "@/components/ui/icons";
import { useEscapeClose } from "@/hooks/use-escape-close";
import type { CommitDiff } from "@claspt/shared/types";

interface CommitDiffModalProps {
  oid: string;
  filePath: string;
  onClose: () => void;
  onRestore?: (oid: string) => void;
}

export function CommitDiffModal({
  oid,
  filePath,
  onClose,
  onRestore,
}: CommitDiffModalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [diff, setDiff] = useState<CommitDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restored, setRestored] = useState(false);

  // Fetch diff data
  useEffect(() => {
    let cancelled = false;
    cmd.gitCommitDiff(oid, filePath).then(
      (d) => {
        if (!cancelled) setDiff(d);
      },
      (e) => {
        if (!cancelled) setError(errorMessage(e));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [oid, filePath]);

  // Create unified merge editor
  useEffect(() => {
    if (!diff || !containerRef.current) return;

    const currentContent = stripSecretValues(diff.current_content ?? "");
    const parentContent = stripSecretValues(diff.parent_content ?? "");

    const view = new EditorView({
      state: EditorState.create({
        doc: currentContent,
        extensions: [
          markdown(),
          ...clasptTheme,
          EditorView.editable.of(false),
          EditorState.readOnly.of(true),
          unifiedMergeView({
            original: parentContent,
            highlightChanges: true,
            gutter: true,
          }),
        ],
      }),
      parent: containerRef.current,
    });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [diff]);

  useEscapeClose(onClose);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 dark:bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="flex w-[80vw] max-w-[900px] flex-col overflow-hidden rounded-2xl border border-border/60 bg-surface shadow-2xl"
        style={{ maxHeight: "80vh" }}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border/60 px-6 py-4">
          <div className="min-w-0 flex-1">
            {diff && (
              <>
                <p className="truncate text-[13px] font-semibold text-text-primary">
                  {diff.message}
                </p>
                <p className="mt-0.5 text-[11px] text-text-muted">
                  {oid.slice(0, 8)} &middot; {formatDate(diff.timestamp)}
                </p>
              </>
            )}
            {!diff && !error && (
              <p className="text-[13px] text-text-muted">Loading diff...</p>
            )}
          </div>
          <div className="ml-3 flex shrink-0 items-center gap-2">
            {diff && onRestore && !restored && (
              <button
                onClick={async () => {
                  setRestoring(true);
                  try {
                    await cmd.gitRestoreToCommit(oid, filePath);
                    setRestored(true);
                    onRestore(oid);
                  } catch (e) {
                    setError(errorMessage(e));
                  }
                  setRestoring(false);
                }}
                disabled={restoring}
                className="rounded-lg border border-accent/60 px-3 py-1.5 text-[11px] font-medium text-accent transition-all hover:bg-accent/10 active:scale-95 disabled:opacity-50"
              >
                {restoring ? "Restoring..." : "Restore this version"}
              </button>
            )}
            {restored && (
              <span className="rounded-lg bg-green-500/10 px-3 py-1.5 text-[11px] font-medium text-green-500">
                Restored
              </span>
            )}
            <button onClick={onClose} className="icon-btn p-1 text-text-muted">
              <CloseIcon />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto px-6 py-4">
          {error && (
            <div className="flex h-[200px] items-center justify-center">
              <p className="text-[13px] text-red-400">{error}</p>
            </div>
          )}
          {!diff && !error && (
            <div className="flex h-[200px] items-center justify-center">
              <p className="text-[13px] text-text-muted">Loading...</p>
            </div>
          )}
          {diff && (
            <div
              ref={containerRef}
              className="overflow-hidden rounded-lg border border-border/60"
            />
          )}
        </div>
      </div>
    </div>
  );
}
