// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * The rules every way of attaching a file follows: the toolbar, a drop and a
 * paste all go through the same dialog, and the dialog reads these.
 *
 * The decisions behind them: encryption is asked per file and never
 * pre-selected; the size limit is the vault's own, capped at 25 MB, and a
 * file over it is refused with both numbers stated, with the offer to raise
 * the limit or, for an image, to shrink it; nothing is shrunk, re-encoded or
 * stripped on its own. Deleting removes a file from the current version of
 * the vault only, because git keeps every earlier version, and the dialog
 * says so before the file goes in.
 */

import { isRaster } from "@claspt/shared/attachments";

export {
  attachmentDisplayName,
  attachmentRefs,
  ATTACHMENT_EXTENSIONS,
  ATTACHMENT_MIME_TYPES,
  extForMime,
  extOf,
  formatSize,
  isAttachmentExt,
  isRaster,
  RASTER_EXTENSIONS,
} from "@claspt/shared/attachments";

/** The most Claspt stores as one attachment, whatever the vault's limit. */
export const MAX_ATTACHMENT_MB = 25;
/** The limit a vault starts with. */
export const DEFAULT_ATTACHMENT_MB = 5;

const MIB = 1024 * 1024;

/** The vault's limit in bytes, clamped to what Claspt allows. */
export function limitBytes(limitMb: number | undefined): number {
  const mb = Math.min(
    Math.max(Math.round(limitMb ?? DEFAULT_ATTACHMENT_MB), 1),
    MAX_ATTACHMENT_MB,
  );
  return mb * MIB;
}

export type SizeCheck =
  | { over: false }
  | {
      over: true;
      /** What to say: the file's size and the vault's limit. */
      sizeMb: number;
      limitMb: number;
      /** The smallest whole-MB limit that would take this file, if Claspt allows it. */
      raiseTo: number | null;
      /** Whether shrinking is on offer: only images can be resized. */
      canShrink: boolean;
    };

/** Whether `sizeBytes` fits this vault's limit, and what can be done if not. */
export function checkAttachmentSize(
  sizeBytes: number,
  limitMb: number | undefined,
  ext: string,
): SizeCheck {
  const limit = limitBytes(limitMb);
  if (sizeBytes <= limit) return { over: false };
  const needed = Math.ceil(sizeBytes / MIB);
  return {
    over: true,
    sizeMb: Math.round((sizeBytes / MIB) * 10) / 10,
    limitMb: limit / MIB,
    raiseTo: needed <= MAX_ATTACHMENT_MB ? needed : null,
    canShrink: isRaster(ext),
  };
}

/** What the encrypt box means, in the owner's terms, for the state it is in. */
export function encryptionNote(encrypt: boolean): string {
  return encrypt
    ? "This file will be encrypted. It opens only inside Claspt; in the vault folder it is unreadable."
    : "This file will not be encrypted and can be read from the vault folder in Finder.";
}

/** Shown in the attach dialog every time, before the file goes in. */
export const GIT_HISTORY_NOTE =
  "Deleting an attachment later removes it from the current version only. Git keeps every earlier version of the vault, so the file stays in the history.";

/**
 * Where a file to attach comes from: a path the owner picked or dropped, or
 * a File from the clipboard or an HTML5 drop. Bytes are read only when the
 * file actually goes in, so a refused file is never loaded.
 */
export type AttachSource =
  | { kind: "path"; id: number; path: string; name: string; ext: string; size: number }
  | { kind: "file"; id: number; file: File; name: string; ext: string; size: number };

/**
 * Remove every `![…](mdPath)` reference from a page. A line that held only
 * the reference goes with it, so deleting an attachment leaves no blank line
 * behind; a line with other text keeps that text.
 */
export function removeAttachmentReferences(content: string, mdPath: string): string {
  // The target may be followed by a title (the owner's comment) before the
  // closing bracket.
  const targets = [`](${mdPath})`, `](${mdPath} `];
  const escaped = mdPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const reference = new RegExp(
    `!\\[[^\\]]*\\]\\(${escaped}(?:\\s+"(?:[^"\\\\]|\\\\.)*")?\\)`,
    "g",
  );
  const kept: string[] = [];
  for (const line of content.split("\n")) {
    if (!targets.some((target) => line.includes(target))) {
      kept.push(line);
      continue;
    }
    const stripped = line.replace(reference, "");
    if (stripped.trim() !== "") kept.push(stripped);
  }
  return kept.join("\n");
}

/** Bytes of a clipboard or dropped File, read only when it is about to go in. */
export async function fileBytes(file: File): Promise<number[]> {
  return Array.from(new Uint8Array(await file.arrayBuffer()));
}

/**
 * The markdown that references an attachment. A comment goes in the link's
 * title, the one place standard markdown keeps a note about a file, so any
 * other editor shows it and the phone can show it under the file.
 */
export function attachmentMarkdown(alt: string, mdPath: string, comment = ""): string {
  const safeAlt = alt.replace(/[[\]\r\n]/g, " ").trim() || "attachment";
  const safeComment = comment.replace(/\s+/g, " ").replace(/"/g, '\\"').trim();
  return safeComment
    ? `![${safeAlt}](${mdPath} "${safeComment}")`
    : `![${safeAlt}](${mdPath})`;
}

/** A display name for an attachment: the file name without its extension. */
export function altFromName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? name;
  return base.replace(/\.[^.]+$/, "") || "attachment";
}
