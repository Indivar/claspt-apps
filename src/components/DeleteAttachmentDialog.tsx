// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * DeleteAttachmentDialog — confirms deleting an attachment from the vault.
 *
 * It says what deleting means (the current version only; git keeps every
 * earlier one), and checks which other pages of the folder still reference
 * the file, because a content-addressed file attached twice is stored once.
 * The reference on this page is removed and saved first; the file goes
 * second, so a failure cannot leave a page pointing at nothing.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { errorMessage } from "@/lib/error-message";
import { deleteMedia, mediaReferences, type MediaReferences } from "@/lib/commands";
import { formatSize, removeAttachmentReferences } from "@/lib/attachments";
import type { AttachmentTarget } from "@/lib/preview-attachments";
import { usePagesStore } from "@/stores/pages-store";
import { CloseIcon } from "@/components/ui/icons";
import { useEscapeClose } from "@/hooks/use-escape-close";

export function DeleteAttachmentDialog({
  attachment,
  folder,
  content,
  onContentChange,
  onDeleted,
  onClose,
}: {
  attachment: AttachmentTarget;
  folder: string;
  content: string;
  onContentChange?: (content: string) => Promise<void>;
  onDeleted: () => void;
  onClose: () => void;
}) {
  const activePath = usePagesStore((s) => s.activePage?.path);
  const [references, setReferences] = useState<MediaReferences | null>(null);
  const [lookupFailed, setLookupFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEscapeClose(onClose);

  useEffect(() => {
    let cancelled = false;
    mediaReferences(folder, attachment.mdPath)
      .then((refs) => {
        if (!cancelled) setReferences(refs);
      })
      .catch(() => {
        if (!cancelled) setLookupFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [folder, attachment.mdPath]);

  const otherPages = references ? references.pages.filter((p) => p !== activePath) : [];
  const unchecked = references?.unchecked_encrypted ?? 0;

  const handleDelete = async () => {
    setBusy(true);
    setError(null);
    try {
      if (onContentChange) {
        await onContentChange(removeAttachmentReferences(content, attachment.mdPath));
      }
      await deleteMedia(attachment.relPath);
      toast.success(`Deleted ${attachment.name}`);
      onDeleted();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/30 dark:bg-black/50">
      <div className="modal-card flex w-[440px] flex-col overflow-hidden rounded-2xl border border-border/60 bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-border/60 px-6 py-4">
          <h2 className="text-[13px] font-semibold text-text-primary">
            Delete attachment
          </h2>
          <button
            onClick={onClose}
            className="icon-btn p-1 text-text-muted"
            aria-label="Close"
          >
            <CloseIcon />
          </button>
        </div>

        <div className="space-y-3 px-6 py-4">
          <p className="text-[13px] text-text-primary">
            Delete <span className="font-medium">{attachment.name}</span> (
            {formatSize(attachment.size)}) and remove it from this page?
          </p>
          <p className="text-[12px] leading-relaxed text-text-secondary">
            This removes the file from the current version of the vault only. Git keeps
            every earlier version, so the file stays in the history.
          </p>

          {references === null && !lookupFailed && (
            <p className="text-[11px] text-text-muted">
              Checking other pages in this folder…
            </p>
          )}
          {lookupFailed && (
            <p className="text-[11px] text-text-muted">
              Other pages in this folder could not be checked; one of them may still use
              this file.
            </p>
          )}
          {otherPages.length > 0 && (
            <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[12px] text-text-primary">
              <p>
                {otherPages.length === 1
                  ? "One other page in this folder uses this file"
                  : `${otherPages.length} other pages in this folder use this file`}
                ; its reference there will stop working.
              </p>
              <ul className="mt-1 list-disc pl-4 text-[11px] text-text-secondary">
                {otherPages.map((p) => (
                  <li key={p}>{p.slice(p.lastIndexOf("/") + 1)}</li>
                ))}
              </ul>
            </div>
          )}
          {unchecked > 0 && (
            <p className="text-[11px] text-text-muted">
              {unchecked === 1
                ? "One encrypted page in this folder could not be checked."
                : `${unchecked} encrypted pages in this folder could not be checked.`}
            </p>
          )}

          {error && (
            <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border/60 px-6 py-3">
          <button
            onClick={onClose}
            className="rounded-lg px-4 py-1.5 text-[13px] text-text-secondary transition-all hover:bg-surface-overlay active:scale-95"
          >
            Cancel
          </button>
          <button
            onClick={handleDelete}
            disabled={busy}
            className="rounded-lg bg-danger px-5 py-1.5 text-[13px] font-medium text-white transition-all hover:opacity-90 active:scale-95 disabled:opacity-50"
          >
            {busy ? "Deleting…" : "Delete attachment"}
          </button>
        </div>
      </div>
    </div>
  );
}
