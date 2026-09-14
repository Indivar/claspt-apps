// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Renders decrypted secret blocks as interactive cards.
 *
 * Security behavior:
 * - Values arrive already decrypted (decryption happens in the Rust backend);
 *   this component only displays them. It starts in a locked state and reveals
 *   values only on explicit user click.
 * - A revealed card auto-hides after `autoHideDelay` to limit on-screen exposure.
 * - Copying a value writes to the clipboard and schedules an automatic clipboard
 *   clear after `clipboardClearDelay`; on unmount the clipboard is also cleared,
 *   but only if THIS card is what wrote to it (see `didCopyRef`), so we never
 *   wipe content the user copied elsewhere.
 * - Reveal/copy actions are logged as credential-usage events (best-effort).
 *
 * `SecretBlockRenderer` parses `:::secret[Label]...:::` fences out of page
 * content and renders one `SecretCard` per block, wiring edit/delete back to
 * the raw markdown.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useUIStore } from "@/stores/ui-store";
import { copyToClipboard as clipboardWrite, clearClipboardAfter } from "@/lib/clipboard";
import { logCredentialUsage } from "@/lib/commands";

interface SecretField {
  key: string;
  value: string;
}

interface SecretCardProps {
  label: string;
  fields: SecretField[];
  autoHideDelay?: number;
  clipboardClearDelay?: number;
  /** Page path for usage logging. */
  pagePath?: string;
  /** Called when user edits the secret block. Receives new label + fields. */
  onEdit?: (newLabel: string, newFields: SecretField[]) => void;
  /** Called when user deletes the secret block. */
  onDelete?: () => void;
}

/** Split raw block body into key/value fields, splitting each line on the first colon. */
function parseFields(content: string): SecretField[] {
  return content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const colonIdx = line.indexOf(":");
      if (colonIdx > 0) {
        return {
          key: line.slice(0, colonIdx).trim(),
          value: line.slice(colonIdx + 1).trim(),
        };
      }
      return { key: "", value: line.trim() };
    });
}

/**
 * Interactive card for a single secret block. Locked by default; reveals values
 * on click, auto-hides after a delay, and supports inline edit/delete/copy/share.
 */
export function SecretCard({
  label,
  fields,
  autoHideDelay = 30000,
  clipboardClearDelay = 30000,
  pagePath,
  onEdit,
  onDelete,
}: SecretCardProps) {
  const [revealed, setRevealed] = useState(false);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [copiedAll, setCopiedAll] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editLabel, setEditLabel] = useState(label);
  const [editFields, setEditFields] = useState<SecretField[]>(fields);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const clipboardTimerRef = useRef<ReturnType<typeof setTimeout>>();
  // Only this card's own copies should be cleared on unmount — clearing
  // unconditionally would wipe clipboard content the user copied elsewhere.
  const didCopyRef = useRef(false);

  // Auto-hide timer
  useEffect(() => {
    if (!revealed || editing) return;
    const id = setTimeout(() => setRevealed(false), autoHideDelay);
    return () => clearTimeout(id);
  }, [revealed, autoHideDelay, editing]);

  // Clear clipboard on unmount, but only if this card copied a secret to it.
  useEffect(() => {
    return () => {
      if (clipboardTimerRef.current) clearTimeout(clipboardTimerRef.current);
      if (didCopyRef.current) clipboardWrite("").catch(() => {});
    };
  }, []);

  const logUsage = useCallback(
    (action: string, fieldLabel?: string) => {
      if (!pagePath) return;
      logCredentialUsage({
        timestamp: new Date().toISOString(),
        page_path: pagePath,
        label: fieldLabel ?? label,
        action,
        source: "desktop",
        domain: null,
        device_id: null,
      }).catch(() => {});
    },
    [pagePath, label],
  );

  const copyText = useCallback(
    async (text: string) => {
      const ok = await clipboardWrite(text);
      if (!ok) return false;
      didCopyRef.current = true;
      if (clipboardTimerRef.current) clearTimeout(clipboardTimerRef.current);
      clipboardTimerRef.current = clearClipboardAfter(clipboardClearDelay);
      return true;
    },
    [clipboardClearDelay],
  );

  const handleCopyField = useCallback(
    async (index: number) => {
      const ok = await copyText(fields[index]?.value ?? "");
      if (ok) {
        logUsage("copy", fields[index]?.key || label);
        setCopiedIndex(index);
        setTimeout(() => setCopiedIndex(null), 1500);
      }
    },
    [fields, copyText, logUsage, label],
  );

  const handleCopyAll = useCallback(async () => {
    const allValues = fields
      .map((f) => (f.key ? `${f.key}: ${f.value}` : f.value))
      .join("\n");
    const ok = await copyText(allValues);
    if (ok) {
      logUsage("copy");
      setCopiedAll(true);
      setTimeout(() => setCopiedAll(false), 1500);
    }
  }, [fields, copyText, logUsage]);

  const handleToggle = () => {
    if (!revealed) logUsage("reveal");
    setRevealed(!revealed);
    setEditing(false);
    setConfirmDelete(false);
  };

  const startEdit = () => {
    setEditLabel(label);
    setEditFields(fields.map((f) => ({ ...f })));
    setEditing(true);
  };

  const saveEdit = () => {
    if (onEdit) {
      onEdit(editLabel, editFields);
    }
    setEditing(false);
  };

  const cancelEdit = () => {
    setEditing(false);
    setEditLabel(label);
    setEditFields(fields);
  };

  const updateField = (index: number, key: string, value: string) => {
    setEditFields((prev) => {
      const updated = [...prev];
      updated[index] = { key, value };
      return updated;
    });
  };

  const addField = () => {
    setEditFields((prev) => [...prev, { key: "", value: "" }]);
  };

  const removeField = (index: number) => {
    setEditFields((prev) => prev.filter((_, i) => i !== index));
  };

  // Locked state
  if (!revealed) {
    return (
      <button
        onClick={handleToggle}
        className="secret-card-locked my-2 flex w-full items-center gap-3 rounded-xl px-4 py-3.5 text-left"
      >
        <span className="text-lg text-secret">&#x1F512;</span>
        <span className="font-medium text-text-primary">{label}</span>
        <span className="ml-auto text-[10px] font-medium tracking-wide text-text-muted">
          CLICK TO REVEAL
        </span>
      </button>
    );
  }

  // Editing state
  if (editing) {
    return (
      <div className="secret-card-revealed my-2 rounded-xl">
        <div className="border-b border-secret/30 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="text-lg text-secret">&#x270F;&#xFE0F;</span>
            <input
              type="text"
              value={editLabel}
              onChange={(e) => setEditLabel(e.target.value)}
              className="flex-1 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm font-medium text-text-primary outline-none focus:border-accent"
              placeholder="Secret label"
            />
          </div>
        </div>
        <div className="px-4 py-3 space-y-2">
          {editFields.map((field, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                type="text"
                value={field.key}
                onChange={(e) => updateField(i, e.target.value, field.value)}
                className="w-24 rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-text-muted outline-none focus:border-accent"
                placeholder="Key"
              />
              <input
                type="text"
                value={field.value}
                onChange={(e) => updateField(i, field.key, e.target.value)}
                className="flex-1 rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-text-primary outline-none focus:border-accent"
                placeholder="Value"
              />
              <button
                onClick={() => removeField(i)}
                className="shrink-0 rounded p-1 text-xs text-danger/60 hover:text-danger hover:bg-danger/10"
                title="Remove field"
              >
                &#x2715;
              </button>
            </div>
          ))}
          <button
            onClick={addField}
            className="text-xs text-accent hover:text-accent-hover"
          >
            + Add field
          </button>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-secret/30 px-4 py-2.5">
          <button
            onClick={cancelEdit}
            className="rounded px-3 py-1.5 text-xs text-text-muted hover:text-text-primary"
          >
            Cancel
          </button>
          <button
            onClick={saveEdit}
            className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover"
          >
            Save Changes
          </button>
        </div>
      </div>
    );
  }

  // Revealed state
  return (
    <div className="secret-card-revealed my-2 rounded-xl">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-secret/30 px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="text-lg text-secret">&#x1F513;</span>
          <span className="font-medium text-text-primary">{label}</span>
        </div>
        <div className="flex items-center gap-1.5">
          {onEdit && (
            <button
              onClick={startEdit}
              className="rounded px-2 py-1 text-xs text-text-muted hover:text-accent hover:bg-accent/10 transition-colors"
              title="Edit this secret"
            >
              Edit
            </button>
          )}
          <button
            onClick={() => useUIStore.getState().setShareModalOpen(true, label)}
            className="rounded px-2 py-1 text-xs text-text-muted hover:text-text-secondary"
            title="Share this secret"
          >
            Share
          </button>
          <button
            onClick={handleCopyAll}
            className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
              copiedAll
                ? "bg-success/20 text-success"
                : "bg-surface text-text-secondary hover:text-text-primary"
            }`}
          >
            {copiedAll ? "Copied!" : "Copy All"}
          </button>
          <button
            onClick={handleToggle}
            className="rounded px-2 py-1 text-xs text-text-muted hover:text-text-secondary"
          >
            Hide
          </button>
        </div>
      </div>

      {/* Fields */}
      <div className="divide-y divide-secret/10">
        {fields.map((field, i) => (
          <button
            key={i}
            onClick={() => handleCopyField(i)}
            className={`group/field flex w-full items-center px-4 py-2.5 cursor-pointer transition-colors ${
              copiedIndex === i ? "bg-success/10" : "hover:bg-secret/10"
            }`}
            title="Click to copy"
          >
            <div className="min-w-0 flex-1 text-left">
              {field.key && (
                <span className="mr-2 text-xs font-medium text-text-muted">
                  {field.key}
                </span>
              )}
              <span className="text-sm text-text-primary">{field.value}</span>
            </div>
            <span className="ml-2 shrink-0 text-xs cursor-pointer">
              {copiedIndex === i ? (
                <span className="text-success font-medium">Copied!</span>
              ) : (
                <span className="text-text-muted group-hover/field:text-accent transition-colors">
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 16 16"
                    fill="none"
                    className="inline-block mr-0.5 -mt-0.5"
                  >
                    <rect
                      x="5"
                      y="5"
                      width="8"
                      height="8"
                      rx="1.5"
                      stroke="currentColor"
                      strokeWidth="1.3"
                    />
                    <path
                      d="M3 11V3h8"
                      stroke="currentColor"
                      strokeWidth="1.3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  Copy
                </span>
              )}
            </span>
            {/* Quick-delete individual field */}
            {onEdit && fields.length > 1 && (
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  const newFields = fields.filter((_, idx) => idx !== i);
                  if (onEdit) onEdit(label, newFields);
                }}
                role="button"
                className="ml-2 shrink-0 flex h-6 w-6 items-center justify-center rounded-md text-sm font-bold opacity-0 group-hover/field:opacity-100 bg-danger/20 text-danger hover:bg-danger/40 transition-all cursor-pointer"
                title="Remove this field"
              >
                &#x2715;
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Delete — separated at the bottom with confirm/cancel buttons */}
      {onDelete && (
        <div className="border-t border-secret/30 px-4 py-2">
          {confirmDelete ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-danger">Delete this secret?</span>
              <button
                onClick={() => {
                  if (onDelete) onDelete();
                  setConfirmDelete(false);
                }}
                className="rounded bg-danger/20 px-2.5 py-1 text-xs font-medium text-danger hover:bg-danger/30 transition-colors"
              >
                Yes, Delete
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="rounded px-2.5 py-1 text-xs text-text-muted hover:text-text-primary transition-colors"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              className="rounded px-2 py-1 text-xs text-text-dim hover:text-danger transition-colors"
              title="Delete this secret block"
            >
              Delete
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Secret Block Renderer ────────────────────────

/** Parse secret blocks from page content and render SecretCards. */
export function SecretBlockRenderer({
  content,
  autoHideDelay,
  clipboardClearDelay,
  pagePath,
  onContentChange,
}: {
  content: string;
  autoHideDelay?: number;
  clipboardClearDelay?: number;
  pagePath?: string;
  /** Called when a secret block is edited or deleted. Receives the new full content. */
  onContentChange?: (newContent: string) => void;
}) {
  let blocks: SecretBlock[] = [];
  try {
    blocks = parseSecretBlocks(content);
  } catch (err) {
    console.error("[SecretBlockRenderer] parseSecretBlocks failed:", err);
  }
  const containerRef = useRef<HTMLDivElement>(null);

  // Listen for scroll-to-secret events from the editor click handler
  useEffect(() => {
    function onScrollToSecret(e: Event) {
      const { index } = (e as CustomEvent<{ index: number }>).detail;
      const container = containerRef.current;
      if (!container) return;
      const card = container.querySelector(`[data-secret-index="${index}"]`);
      if (card) {
        card.scrollIntoView({ behavior: "smooth", block: "nearest" });
        card.classList.add("secret-card-flash");
        setTimeout(() => card.classList.remove("secret-card-flash"), 800);
      }
    }
    window.addEventListener("claspt:scroll-to-secret", onScrollToSecret);
    return () => window.removeEventListener("claspt:scroll-to-secret", onScrollToSecret);
  }, []);

  const handleEdit = useCallback(
    (blockIndex: number, newLabel: string, newFields: SecretField[]) => {
      if (!onContentChange) return;
      const newBlock = buildSecretBlock(newLabel, newFields);
      const newContent = replaceSecretBlock(content, blockIndex, newBlock);
      onContentChange(newContent);
    },
    [content, onContentChange],
  );

  const handleDelete = useCallback(
    (blockIndex: number) => {
      if (!onContentChange) return;
      const newContent = replaceSecretBlock(content, blockIndex, null);
      onContentChange(newContent);
    },
    [content, onContentChange],
  );

  if (blocks.length === 0) return null;

  return (
    <div ref={containerRef} className="border-t border-border px-6 py-4">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
        Secrets
      </h3>
      {blocks.map((block, i) => (
        <div key={`${block.label}-${i}`} data-secret-index={i}>
          <SecretCard
            label={block.label}
            fields={block.fields}
            autoHideDelay={autoHideDelay}
            clipboardClearDelay={clipboardClearDelay}
            pagePath={pagePath}
            onEdit={
              onContentChange
                ? (newLabel, newFields) => handleEdit(i, newLabel, newFields)
                : undefined
            }
            onDelete={onContentChange ? () => handleDelete(i) : undefined}
          />
        </div>
      ))}
    </div>
  );
}

// ── Types ────────────────────────────────────────

interface SecretBlock {
  label: string;
  fields: SecretField[];
}

// ── Parser ───────────────────────────────────────

/**
 * Extract `:::secret[Label]...:::` blocks from markdown. Skips fenced code and
 * indented code blocks so `:::secret` written inside a code sample is not parsed
 * as a real secret. Escaped `\]` in labels is unescaped.
 */
function parseSecretBlocks(content: string): SecretBlock[] {
  const blocks: SecretBlock[] = [];
  const lines = content.split("\n");
  let i = 0;
  let inCodeFence = false;
  let codeFenceTicks = 0;

  while (i < lines.length) {
    const rawLine = lines[i] ?? "";
    const trimmed = rawLine.trim();

    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/);
    if (fenceMatch) {
      const ticks = fenceMatch[1]!.length;
      if (!inCodeFence) {
        inCodeFence = true;
        codeFenceTicks = ticks;
        i++;
        continue;
      } else if (ticks >= codeFenceTicks && trimmed === fenceMatch[1]) {
        inCodeFence = false;
        codeFenceTicks = 0;
        i++;
        continue;
      }
    }

    if (inCodeFence) {
      i++;
      continue;
    }
    if (/^( {4}|\t)/.test(rawLine)) {
      i++;
      continue;
    }

    const match = trimmed.match(/^:::secret\[((?:[^\]\\]|\\.)*)\]/);
    if (match) {
      const label = (match[1] ?? "").replace(/\\\]/g, "]");
      const blockLines: string[] = [];
      i++;
      while (i < lines.length) {
        const innerLine = lines[i]?.trim() ?? "";
        if (innerLine === ":::") break;
        blockLines.push(lines[i] ?? "");
        i++;
      }
      blocks.push({ label, fields: parseFields(blockLines.join("\n")) });
    }
    i++;
  }
  return blocks;
}

// ── Content Manipulation ─────────────────────────

/** Build a :::secret block string from label and fields. */
function buildSecretBlock(label: string, fields: SecretField[]): string {
  const escapedLabel = label.replace(/\]/g, "\\]");
  let block = `:::secret[${escapedLabel}]\n`;
  for (const f of fields) {
    if (f.key && f.value) {
      block += `${f.key}: ${f.value}\n`;
    } else if (f.value) {
      block += `${f.value}\n`;
    }
  }
  block += ":::";
  return block;
}

/**
 * Replace or remove the Nth secret block in the content.
 * If `replacement` is null, the block is deleted (with surrounding blank lines cleaned up).
 */
function replaceSecretBlock(
  content: string,
  blockIndex: number,
  replacement: string | null,
): string {
  const lines = content.split("\n");
  let currentBlock = -1;
  let inCodeFence = false;
  let codeFenceTicks = 0;
  let blockStartLine = -1;
  let blockEndLine = -1;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? "";
    const trimmed = rawLine.trim();

    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/);
    if (fenceMatch) {
      const ticks = fenceMatch[1]!.length;
      if (!inCodeFence) {
        inCodeFence = true;
        codeFenceTicks = ticks;
        continue;
      } else if (ticks >= codeFenceTicks && trimmed === fenceMatch[1]) {
        inCodeFence = false;
        codeFenceTicks = 0;
        continue;
      }
    }
    if (inCodeFence) continue;
    if (/^( {4}|\t)/.test(rawLine)) continue;

    if (trimmed.match(/^:::secret\[((?:[^\]\\]|\\.)*)\]/)) {
      currentBlock++;
      if (currentBlock === blockIndex) {
        blockStartLine = i;
        // Find the closing :::
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j]?.trim() === ":::") {
            blockEndLine = j;
            break;
          }
        }
        break;
      }
    }
  }

  if (blockStartLine === -1 || blockEndLine === -1) return content;

  // Remove surrounding blank lines when deleting
  let removeStart = blockStartLine;
  let removeEnd = blockEndLine;
  if (replacement === null) {
    // Remove blank line before if present
    if (removeStart > 0 && (lines[removeStart - 1]?.trim() ?? "") === "") {
      removeStart--;
    }
    // Remove blank line after if present
    if (removeEnd < lines.length - 1 && (lines[removeEnd + 1]?.trim() ?? "") === "") {
      removeEnd++;
    }
  }

  const before = lines.slice(0, removeStart);
  const after = lines.slice(removeEnd + 1);

  if (replacement === null) {
    return [...before, ...after].join("\n");
  }

  return [...before, replacement, ...after].join("\n");
}
