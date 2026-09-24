// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * What an attachment is, on every platform: the file types Claspt attaches,
 * their MIME types, how a size reads in a sentence, and how a page's
 * `_media/` references are found. The desktop attaches and edits; the phone
 * displays; both read the same rules here so they cannot drift.
 */

export const RASTER_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"] as const;
export const ATTACHMENT_EXTENSIONS = [...RASTER_EXTENSIONS, "svg", "pdf"] as const;

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
};

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
};

export const ATTACHMENT_MIME_TYPES = Object.keys(EXTENSION_BY_MIME);

/**
 * Bytes a sealed file carries beyond its plaintext: the 16-byte magic, the
 * 12-byte nonce and the 16-byte tag. Mirrors `attachment::OVERHEAD` in the
 * core crate, so a listing can state the original size without opening
 * the file.
 */
export const SEALED_OVERHEAD = 16 + 12 + 16;

const MIB = 1024 * 1024;

/** A size for a sentence: "7.3 MB", "120.5 KB", "800 B". */
export function formatSize(bytes: number): string {
  if (bytes >= MIB) return `${(bytes / MIB).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** The extension of a file name or path, lower-cased, without the dot. */
export function extOf(name: string): string {
  const base = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);
  const dot = base.lastIndexOf(".");
  return dot < 0 ? "" : base.slice(dot + 1).toLowerCase();
}

/** Whether a file of this type can be shrunk by the image transform. */
export function isRaster(ext: string): boolean {
  return (RASTER_EXTENSIONS as readonly string[]).includes(ext.toLowerCase());
}

/** Whether Claspt attaches files of this extension at all. */
export function isAttachmentExt(ext: string): boolean {
  return (ATTACHMENT_EXTENSIONS as readonly string[]).includes(ext.toLowerCase());
}

/** The MIME type for an attachment's extension; unknown types are opaque bytes. */
export function mimeForExt(ext: string): string {
  return MIME_BY_EXTENSION[ext.toLowerCase()] ?? "application/octet-stream";
}

/** The extension for a pasted file that has a type but no usable name. */
export function extForMime(mime: string): string {
  return EXTENSION_BY_MIME[mime] ?? "";
}

/** How a rendered page shows a file: inline as an image, or as a chip. */
export type AttachmentKind = "image" | "svg" | "file";

export function attachmentKind(ext: string): AttachmentKind {
  const lower = ext.toLowerCase();
  if (isRaster(lower)) return "image";
  if (lower === "svg") return "svg";
  return "file";
}

/**
 * The name to show for an attachment: the original file name, kept in the
 * reference's alt text when the file was attached, with its extension; the
 * stored name (a random one) only when the alt is empty.
 */
export function attachmentDisplayName(
  alt: string | undefined,
  storedName: string,
  ext: string,
): string {
  const base = (alt ?? "").trim();
  if (!base) return storedName;
  if (ext && base.toLowerCase().endsWith(`.${ext.toLowerCase()}`)) return base;
  return ext ? `${base}.${ext}` : base;
}

/** Every distinct `_media/` link target a page references, in order of first use. */
export function attachmentRefs(content: string): string[] {
  const refs: string[] = [];
  // A reference may carry a title, the owner's comment: `![name](_media/x "why")`.
  const pattern = /!\[[^\]]*\]\((_media\/[^)\s]+)(?:\s+"(?:[^"\\]|\\.)*")?\)/g;
  for (const match of content.matchAll(pattern)) {
    const target = match[1];
    if (target && !refs.includes(target)) refs.push(target);
  }
  return refs;
}

/** The size an SVG declares, for laying it out before it is drawn. */
export function svgDimensions(xml: string): { width: number; height: number } | null {
  const open = /<svg\b[^>]*>/i.exec(xml);
  if (!open) return null;
  const attrs = open[0];
  const viewBox =
    /\bviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i.exec(
      attrs,
    );
  const width = /\bwidth\s*=\s*["']([\d.]+)(?:px)?["']/i.exec(attrs);
  const height = /\bheight\s*=\s*["']([\d.]+)(?:px)?["']/i.exec(attrs);
  if (width && height) return { width: Number(width[1]), height: Number(height[1]) };
  if (viewBox) return { width: Number(viewBox[1]), height: Number(viewBox[2]) };
  return null;
}
