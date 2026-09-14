// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * ImageOptionsModal — image transform dialog for the editor's "insert with
 * options" flow.
 *
 * Lets the user pick an output format, resize percentage, rotation, and
 * (for JPEG/WebP) quality, with a debounced live preview and before/after
 * size info from the Rust backend. On insert it processes and saves the
 * transformed media into the vault and inserts the markdown image reference.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "@/lib/error-message";
import { previewImageTransform, processAndSaveMedia } from "@/lib/commands";
import { usePagesStore } from "@/stores/pages-store";
import { insertImageMarkdown } from "./editor-api";
import { CloseIcon } from "@/components/ui/icons";
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

/** Human-readable byte size (B/KB/MB) for the original/output size labels. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Image transform + insert dialog for a picked source file. */
export function ImageOptionsModal({
  filePath,
  onClose,
}: {
  filePath: string;
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

  const showQuality = format === "jpeg" || format === "webp";

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

  // Fetch preview on param change (debounced)
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const result = await previewImageTransform(filePath, buildParams());
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
  }, [filePath, buildParams]);

  useEscapeClose(onClose);

  const handleInsert = async () => {
    setInserting(true);
    setError(null);
    try {
      const mf = await processAndSaveMedia(folder, filePath, buildParams());
      const name =
        filePath
          .split(/[/\\]/)
          .pop()
          ?.replace(/\.[^.]+$/, "") ?? "image";
      insertImageMarkdown(name, mf.md_path);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setInserting(false);
    }
  };

  return (
    <div className="modal-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/30 dark:bg-black/50">
      <div className="modal-card flex w-[480px] flex-col overflow-hidden rounded-2xl border border-border/60 bg-surface shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border/60 px-6 py-4">
          <h2 className="text-[13px] font-semibold text-text-primary">Image Options</h2>
          <button onClick={onClose} className="icon-btn p-1 text-text-muted">
            <CloseIcon />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {/* Preview */}
          <div className="flex items-center justify-center rounded-lg border border-border bg-surface-raised p-3">
            {preview ? (
              <img
                src={preview.preview_data_url}
                alt="Preview"
                className="max-h-[200px] max-w-full object-contain"
              />
            ) : loading ? (
              <div className="flex h-[120px] items-center justify-center text-xs text-text-muted">
                Loading preview...
              </div>
            ) : (
              <div className="flex h-[120px] items-center justify-center text-xs text-text-muted">
                No preview
              </div>
            )}
          </div>

          {/* Info row */}
          {preview && (
            <div className="flex justify-between text-[11px] text-text-muted">
              <span>
                Original: {preview.original_width}x{preview.original_height},{" "}
                {formatSize(preview.original_size)}
              </span>
              <span>
                Output: {preview.output_width}x{preview.output_height},{" "}
                {formatSize(preview.output_size)}
              </span>
            </div>
          )}

          {/* Format */}
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

          {/* Resize */}
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

          {/* Rotate */}
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

          {/* Quality */}
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

          {error && (
            <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
              {error}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-border/60 px-6 py-3">
          <button
            onClick={onClose}
            className="rounded-lg px-4 py-1.5 text-[13px] text-text-secondary transition-all hover:bg-surface-overlay active:scale-95"
          >
            Cancel
          </button>
          <button
            onClick={handleInsert}
            disabled={inserting || !preview}
            className="rounded-lg bg-accent px-5 py-1.5 text-[13px] font-medium text-white transition-all hover:bg-accent-hover hover:shadow-md active:scale-95 disabled:opacity-50"
          >
            {inserting ? "Inserting..." : "Insert"}
          </button>
        </div>
      </div>
    </div>
  );
}
