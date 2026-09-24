// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * AttachDialog — the one dialog every attached file goes through, whether
 * it came from the toolbar, a drop or a paste.
 *
 * It shows the file, asks whether to encrypt it (never pre-ticked beyond the
 * owner's last answer), states what each choice means, and refuses a file
 * over the vault's limit with both numbers and two ways forward: raise the
 * limit, or for an image resize it. It also says, every time, that deleting
 * an attachment later removes it from the current version only.
 */
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { errorMessage } from "@/lib/error-message";
import { saveMedia, saveMediaFromPath, type MediaFile } from "@/lib/commands";
import {
  altFromName,
  checkAttachmentSize,
  DEFAULT_ATTACHMENT_MB,
  encryptionNote,
  fileBytes,
  formatSize,
  GIT_HISTORY_NOTE,
  isRaster,
  limitBytes,
  MAX_ATTACHMENT_MB,
  type AttachSource,
} from "@/lib/attachments";
import { useVaultStore } from "@/stores/vault-store";
import { usePagesStore } from "@/stores/pages-store";
import { useAttachStore } from "@/stores/attach-store";
import { insertImageMarkdown } from "./editor-api";
import { ImageOptionsModal } from "./ImageOptionsModal";
import { CloseIcon, LockClosedIcon, LockOpenIcon } from "@/components/ui/icons";
import { useEscapeClose } from "@/hooks/use-escape-close";

/** Mounts the dialog for the file at the head of the attach queue. */
export function AttachDialogHost() {
  const current = useAttachStore((s) => s.queue[0]);
  const finish = useAttachStore((s) => s.finish);
  if (!current) return null;
  return <AttachDialog key={current.id} source={current} onClose={finish} />;
}

function FileTypeIcon({ ext }: { ext: string }) {
  if (ext === "pdf") {
    return (
      <svg
        width="28"
        height="28"
        viewBox="0 0 24 24"
        fill="none"
        className="shrink-0 text-text-muted"
      >
        <path
          d="M6 2h8l5 5v13a2 2 0 01-2 2H6a2 2 0 01-2-2V4a2 2 0 012-2z"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path d="M14 2v5h5" stroke="currentColor" strokeWidth="1.5" />
        <path
          d="M8 13h8M8 17h5"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 24 24"
      fill="none"
      className="shrink-0 text-text-muted"
    >
      <rect
        x="3"
        y="4"
        width="18"
        height="16"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <circle cx="8.5" cy="9.5" r="1.5" fill="currentColor" />
      <path
        d="M3 17l5-5 3 3 4-4 6 6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function AttachDialog({
  source,
  onClose,
}: {
  source: AttachSource;
  onClose: () => void;
}) {
  const config = useVaultStore((s) => s.config);
  const updateConfig = useVaultStore((s) => s.updateConfig);
  const folder = usePagesStore((s) => s.activePage?.meta.folder ?? "general");

  const [encrypt, setEncrypt] = useState(config?.attachment_encrypt_default ?? false);
  const [adjusting, setAdjusting] = useState(false);
  const [busy, setBusy] = useState<"attach" | "raise" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Shown under the file in the page; kept in the link's title in the markdown.
  const [comment, setComment] = useState("");

  // While the image adjust view is up it owns Escape; two handlers would
  // close both layers at once.
  const closeUnlessAdjusting = useCallback(() => {
    if (!adjusting) onClose();
  }, [adjusting, onClose]);
  useEscapeClose(closeUnlessAdjusting);

  const limitMb = config?.attachment_size_limit_mb ?? DEFAULT_ATTACHMENT_MB;
  const check = checkAttachmentSize(source.size, limitMb, source.ext);
  const raiseTo = check.over ? check.raiseTo : null;
  const raster = isRaster(source.ext);

  /** The answer to the encrypt question is kept per vault for the next file. */
  const rememberAnswer = async (answer: boolean) => {
    if (config && (config.attachment_encrypt_default ?? false) !== answer) {
      await updateConfig({ ...config, attachment_encrypt_default: answer });
    }
  };

  const finishWith = async (mf: MediaFile, answer: boolean) => {
    await rememberAnswer(answer);
    insertImageMarkdown(altFromName(source.name), mf.md_path, comment);
    toast.success(
      `Attached ${source.name} (${formatSize(mf.size)}${mf.sealed ? ", encrypted" : ""})`,
    );
    onClose();
  };

  const attach = async () => {
    setBusy("attach");
    setError(null);
    try {
      const mf =
        source.kind === "path"
          ? await saveMediaFromPath(folder, source.path, encrypt)
          : await saveMedia(folder, await fileBytes(source.file), source.ext, encrypt);
      await finishWith(mf, encrypt);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(null);
    }
  };

  const raiseLimit = async (mb: number) => {
    if (!config) return;
    setBusy("raise");
    setError(null);
    try {
      await updateConfig({ ...config, attachment_size_limit_mb: mb });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  if (adjusting) {
    return (
      <ImageOptionsModal
        source={source}
        encrypt={encrypt}
        onEncryptChange={setEncrypt}
        limit={limitBytes(limitMb)}
        onBack={() => setAdjusting(false)}
        onDone={(mf) => finishWith(mf, encrypt)}
        onClose={onClose}
      />
    );
  }

  return (
    <div className="modal-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/30 dark:bg-black/50">
      <div className="modal-card flex w-[460px] flex-col overflow-hidden rounded-2xl border border-border/60 bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-border/60 px-6 py-4">
          <h2 className="text-[13px] font-semibold text-text-primary">Attach file</h2>
          <button
            onClick={onClose}
            className="icon-btn p-1 text-text-muted"
            aria-label="Close"
          >
            <CloseIcon />
          </button>
        </div>

        <div className="space-y-4 px-6 py-4">
          <div className="flex items-center gap-3 rounded-lg border border-border/60 bg-surface-raised px-3 py-2.5">
            <FileTypeIcon ext={source.ext} />
            <div className="min-w-0 flex-1">
              <div
                className="truncate text-[13px] font-medium text-text-primary"
                title={source.name}
              >
                {source.name}
              </div>
              <div className="text-[11px] text-text-muted">
                {source.ext.toUpperCase()} · {formatSize(source.size)}
              </div>
            </div>
          </div>

          {check.over ? (
            <div className="space-y-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-3">
              <p className="text-[13px] text-text-primary">
                This file is {check.sizeMb} MB. This vault&apos;s limit is {check.limitMb}{" "}
                MB per attachment.
              </p>
              {raiseTo === null && (
                <p className="text-[12px] text-text-secondary">
                  Claspt allows at most {MAX_ATTACHMENT_MB} MB per attachment
                  {check.canShrink
                    ? ", so this image has to be made smaller first."
                    : "."}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {raiseTo !== null && (
                  <button
                    onClick={() => raiseLimit(raiseTo)}
                    disabled={busy !== null}
                    className="rounded-lg border border-border/60 px-3 py-1.5 text-[12px] text-text-primary transition-all hover:border-text-muted disabled:opacity-50"
                  >
                    {busy === "raise" ? "Raising…" : `Raise the limit to ${raiseTo} MB`}
                  </button>
                )}
                {check.canShrink && (
                  <button
                    onClick={() => setAdjusting(true)}
                    disabled={busy !== null}
                    className="rounded-lg border border-border/60 px-3 py-1.5 text-[12px] text-text-primary transition-all hover:border-text-muted disabled:opacity-50"
                  >
                    Resize to fit…
                  </button>
                )}
              </div>
              <p className="text-[11px] leading-relaxed text-text-muted">
                Claspt never shrinks, re-encodes or strips a file on its own.
              </p>
            </div>
          ) : (
            <>
              <label className="flex cursor-pointer items-start gap-2.5">
                <input
                  type="checkbox"
                  checked={encrypt}
                  onChange={(e) => setEncrypt(e.target.checked)}
                  className="mt-0.5 accent-accent"
                />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-[13px] text-text-primary">
                    {encrypt ? <LockClosedIcon size={12} /> : <LockOpenIcon size={12} />}
                    Encrypt this file
                  </span>
                  <span className="mt-0.5 block text-[12px] leading-relaxed text-text-secondary">
                    {encryptionNote(encrypt)}
                  </span>
                </span>
              </label>
              <label className="block">
                <span className="text-[12px] font-medium text-text-secondary">
                  Comment <span className="font-normal text-text-muted">(optional)</span>
                </span>
                <input
                  type="text"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="What this file is; shown under it on the page"
                  maxLength={200}
                  className="mt-1 w-full rounded-lg border border-border/60 bg-surface px-3 py-1.5 text-[13px] text-text-primary placeholder:text-text-muted/60"
                />
              </label>
              <p className="text-[11px] leading-relaxed text-text-muted">
                {GIT_HISTORY_NOTE}
              </p>
            </>
          )}

          {error && (
            <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border/60 px-6 py-3">
          <div>
            {raster && !check.over && (
              <button
                onClick={() => setAdjusting(true)}
                disabled={busy !== null}
                className="text-[12px] text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50"
              >
                Adjust image (resize, convert)…
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="rounded-lg px-4 py-1.5 text-[13px] text-text-secondary transition-all hover:bg-surface-overlay active:scale-95"
            >
              Cancel
            </button>
            {!check.over && (
              <button
                onClick={attach}
                disabled={busy !== null}
                className="rounded-lg bg-accent px-5 py-1.5 text-[13px] font-medium text-white transition-all hover:bg-accent-hover hover:shadow-md active:scale-95 disabled:opacity-50"
              >
                {busy === "attach" ? "Attaching…" : "Attach"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
