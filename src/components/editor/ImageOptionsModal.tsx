// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * ImageOptionsModal — the "adjust image" step of the attach dialog.
 *
 * Lets the owner pick an output format, resize percentage, rotation and
 * (for JPEG/WebP) quality, with a debounced live preview and before/after
 * sizes from the Rust backend. Nothing is changed unless the owner asks
 * for it here. The vault's size limit applies to the output: an output over
 * it cannot be attached until it is made smaller.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "@/lib/error-message";
import {
  previewImageTransform,
  previewImageTransformBytes,
  processAndSaveMedia,
  processAndSaveMediaBytes,
  type MediaFile,
} from "@/lib/commands";
import {
  encryptionNote,
  fileBytes,
  formatSize,
  type AttachSource,
} from "@/lib/attachments";
import { usePagesStore } from "@/stores/pages-store";
import { CloseIcon, LockClosedIcon, LockOpenIcon } from "@/components/ui/icons";
import { useEscapeClose } from "@/hooks/use-escape-close";
import type { ImageTransformParams, ImageTransformPreview } from "@claspt/shared/types";

const OUTPUT_FORMATS = [
  { value: "original", label: "Original" },
  { value: "png", label: "PNG" },
  { value: "jpeg", label: "JPEG" },
  { value: "webp", label: "WebP" },
  { value: "gif", label: "GIF" },
];

const ROTATIONS = [0, 90, 180, 270] as const;

/** Image transform step for a file that is about to be attached. */
export function ImageOptionsModal({
  source,
  encrypt,
  onEncryptChange,
  limit,
  onBack,
  onDone,
  onClose,
}: {
  source: AttachSource;
  encrypt: boolean;
  onEncryptChange: (encrypt: boolean) => void;
  /** The vault's limit in bytes; the output must fit it. */
  limit: number;
  onBack: () => void;
  onDone: (saved: MediaFile) => Promise<void>;
  onClose: () => void;
}) {
  const folder = usePagesStore((s) => s.activePage?.meta.folder ?? "general");

  const [format, setFormat] = useState("original");
  const [percent, setPercent] = useState(100);
  const [rotation, setRotation] = useState<number>(0);
  const [quality, setQuality] = useState(85);
  const [preview, setPreview] = useState<ImageTransformPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [inserting, setInserting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A pasted or dropped File is read once, for every preview and the save.
  const bytesRef = useRef<Promise<number[]> | null>(null);
  const bytes = useCallback((file: File) => {
    if (!bytesRef.current) bytesRef.current = fileBytes(file);
    return bytesRef.current;
  }, []);

  const showQuality = format === "jpeg" || format === "webp";
  const tooBig = preview !== null && preview.output_size > limit;

  const buildParams = useCallback(
    (): ImageTransformParams => ({
      format,
      width: null,
      height: null,
      percent: percent < 100 ? percent : null,
      rotation,
      quality,
    }),
    [format, percent, rotation, quality],
  );

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const params = buildParams();
        const result =
          source.kind === "path"
            ? await previewImageTransform(source.path, params)
            : await previewImageTransformBytes(
                await bytes(source.file),
                source.ext,
                params,
              );
        setPreview(result);
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [source, buildParams, bytes]);

  useEscapeClose(onBack);

  const handleAttach = async () => {
    setInserting(true);
    setError(null);
    try {
      const params = buildParams();
      const mf =
        source.kind === "path"
          ? await processAndSaveMedia(folder, source.path, params, encrypt)
          : await processAndSaveMediaBytes(
              folder,
              await bytes(source.file),
              source.ext,
              params,
              encrypt,
            );
      await onDone(mf);
    } catch (e) {
      setError(errorMessage(e));
      setInserting(false);
    }
  };

  return (
    <div className="modal-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/30 dark:bg-black/50">
      <div className="modal-card flex w-[480px] flex-col overflow-hidden rounded-2xl border border-border/60 bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-border/60 px-6 py-4">
          <h2 className="text-[13px] font-semibold text-text-primary">Adjust image</h2>
          <button
            onClick={onClose}
            className="icon-btn p-1 text-text-muted"
            aria-label="Close"
          >
            <CloseIcon />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-4">
          <div className="flex items-center justify-center rounded-lg border border-border bg-surface-raised p-3">
            {preview ? (
              <img
                src={preview.preview_data_url}
                alt="Preview"
                className="max-h-[200px] max-w-full object-contain"
              />
            ) : (
              <div className="flex h-[120px] items-center justify-center text-xs text-text-muted">
                {loading ? "Loading preview…" : "No preview"}
              </div>
            )}
          </div>

          {preview && (
            <div className="flex justify-between text-[11px] text-text-muted">
              <span>
                Original: {preview.original_width}×{preview.original_height},{" "}
                {formatSize(preview.original_size)}
              </span>
              <span className={tooBig ? "text-warning" : undefined}>
                Output: {preview.output_width}×{preview.output_height},{" "}
                {formatSize(preview.output_size)}
              </span>
            </div>
          )}
          {tooBig && (
            <p className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[12px] text-text-primary">
              The output is {formatSize(preview.output_size)}; this vault&apos;s limit is{" "}
              {formatSize(limit)}. Lower the size or the quality until it fits.
            </p>
          )}

          <div>
            <label className="mb-1 block text-xs font-medium text-text-muted">
              Format
            </label>
            <div className="flex gap-1.5">
              {OUTPUT_FORMATS.map((f) => (
                <button
                  key={f.value}
                  onClick={() => setFormat(f.value)}
                  className={`rounded-lg border px-2.5 py-1.5 text-[12px] transition-all ${
                    format === f.value
                      ? "border-accent bg-accent/10 text-accent"
                      : "border-border/60 text-text-secondary hover:border-text-muted"
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-text-muted">
              Resize: {percent}%
            </label>
            <input
              type="range"
              min={10}
              max={100}
              value={percent}
              onChange={(e) => setPercent(Number(e.target.value))}
              className="w-full accent-accent"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-text-muted">
              Rotate
            </label>
            <div className="flex gap-1.5">
              {ROTATIONS.map((r) => (
                <button
                  key={r}
                  onClick={() => setRotation(r)}
                  className={`rounded-lg border px-3 py-1.5 text-[12px] transition-all ${
                    rotation === r
                      ? "border-accent bg-accent/10 text-accent"
                      : "border-border/60 text-text-secondary hover:border-text-muted"
                  }`}
                >
                  {r}°
                </button>
              ))}
            </div>
          </div>

          {showQuality && (
            <div>
              <label className="mb-1 block text-xs font-medium text-text-muted">
                Quality: {quality}%
              </label>
              <input
                type="range"
                min={1}
                max={100}
                value={quality}
                onChange={(e) => setQuality(Number(e.target.value))}
                className="w-full accent-accent"
              />
            </div>
          )}

          <label className="flex cursor-pointer items-start gap-2.5 border-t border-border/60 pt-4">
            <input
              type="checkbox"
              checked={encrypt}
              onChange={(e) => onEncryptChange(e.target.checked)}
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

          {error && (
            <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border/60 px-6 py-3">
          <button
            onClick={onBack}
            className="text-[12px] text-text-secondary transition-colors hover:text-text-primary"
          >
            ← Back
          </button>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="rounded-lg px-4 py-1.5 text-[13px] text-text-secondary transition-all hover:bg-surface-overlay active:scale-95"
            >
              Cancel
            </button>
            <button
              onClick={handleAttach}
              disabled={inserting || !preview || tooBig}
              className="rounded-lg bg-accent px-5 py-1.5 text-[13px] font-medium text-white transition-all hover:bg-accent-hover hover:shadow-md active:scale-95 disabled:opacity-50"
            >
              {inserting ? "Attaching…" : "Attach"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
