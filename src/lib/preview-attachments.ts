// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * How an attachment appears in the rendered page, and how the context menu
 * finds it again.
 *
 * `marked` turns `![name](_media/x)` into an `<img>`. An image is shown from
 * its bytes, with a lock badge when the file is sealed. A PDF is never
 * rendered inline: its `<img>` is replaced by a chip with the name and size.
 * Both carry `data-attachment` attributes so a right-click knows the file.
 * Every change returns an undo, so the rendered DOM can be put back before
 * the next resolve pass runs over it.
 */
import type { MediaRead } from "@/lib/commands";
import { attachmentDisplayName, formatSize } from "@/lib/attachments";

/** What the context menu learns from a right-click on an attachment. */
export interface AttachmentTarget {
  relPath: string;
  mdPath: string;
  sealed: boolean;
  name: string;
  size: number;
  ext: string;
}

const SVG_NS = "http://www.w3.org/2000/svg";

function svg(paths: string[], size: number): SVGSVGElement {
  const el = document.createElementNS(SVG_NS, "svg");
  el.setAttribute("width", String(size));
  el.setAttribute("height", String(size));
  el.setAttribute("viewBox", "0 0 16 16");
  el.setAttribute("fill", "none");
  el.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.5");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    el.appendChild(path);
  }
  return el;
}

function lockIcon(size: number): SVGSVGElement {
  return svg(["M3.75 7.5h8.5v6h-8.5z", "M5 7.5V5a3 3 0 016 0v2.5"], size);
}

function fileIcon(size: number): SVGSVGElement {
  return svg(["M4 1.5h5l3.5 3.5v9.5H4z", "M9 1.5V5h3.5", "M6 9h4M6 11.5h3"], size);
}

/** The badge on a sealed file: the owner sees at a glance that it is encrypted. */
function lockBadge(inline: boolean): HTMLSpanElement {
  const badge = document.createElement("span");
  badge.className = inline ? "claspt-attachment-lock-inline" : "claspt-attachment-lock";
  badge.title = "Encrypted. This file opens only inside Claspt.";
  badge.appendChild(lockIcon(11));
  const text = document.createElement("span");
  text.textContent = "Encrypted";
  badge.appendChild(text);
  return badge;
}

/** What the reference itself says about the file: its name and the comment. */
function wordsOf(
  img: HTMLImageElement,
  read: MediaRead,
): { name: string; caption: string } {
  return {
    name: attachmentDisplayName(img.getAttribute("alt") ?? "", read.name, read.ext),
    caption: (img.getAttribute("title") ?? "").trim(),
  };
}

function captionEl(text: string): HTMLSpanElement {
  const caption = document.createElement("span");
  caption.className = "claspt-attachment-caption";
  caption.textContent = text;
  return caption;
}

function describe(el: HTMLElement, read: MediaRead, name: string): void {
  el.dataset.attachment = "1";
  el.dataset.relPath = read.rel_path;
  el.dataset.mdPath = read.md_path;
  el.dataset.sealed = read.sealed ? "1" : "0";
  el.dataset.name = name;
  el.dataset.size = String(read.size);
  el.dataset.ext = read.ext;
}

function undescribe(el: HTMLElement): void {
  for (const key of [
    "attachment",
    "relPath",
    "mdPath",
    "sealed",
    "name",
    "size",
    "ext",
  ]) {
    delete el.dataset[key];
  }
}

/** Show an image from its bytes, badged when sealed. Returns the undo. */
export function showImage(img: HTMLImageElement, read: MediaRead): () => void {
  const originalSrc = img.getAttribute("src") ?? "";
  const originalTitle = img.getAttribute("title");
  const { name, caption } = wordsOf(img, read);
  img.src = read.data_url;
  img.style.display = "";
  img.loading = "lazy";
  img.title = `${name} · ${formatSize(read.size)}${read.sealed ? " · encrypted" : ""}`;
  describe(img, read, name);

  // A badge or a caption is a sibling of the image, so a right-click on
  // either must still find the attachment.
  let wrapper: HTMLSpanElement | null = null;
  if (read.sealed || caption) {
    wrapper = document.createElement("span");
    wrapper.className = "claspt-attachment";
    describe(wrapper, read, name);
    img.replaceWith(wrapper);
    wrapper.appendChild(img);
    if (read.sealed) wrapper.appendChild(lockBadge(false));
    if (caption) wrapper.appendChild(captionEl(caption));
  }

  return () => {
    if (wrapper) wrapper.replaceWith(img);
    img.setAttribute("src", originalSrc);
    if (originalTitle === null) img.removeAttribute("title");
    else img.setAttribute("title", originalTitle);
    undescribe(img);
  };
}

/** Replace a PDF's `<img>` with a chip naming the file. Returns the undo. */
export function showChip(img: HTMLImageElement, read: MediaRead): () => void {
  const words = wordsOf(img, read);
  const chip = document.createElement("span");
  chip.className = "claspt-attachment-chip";
  chip.title = "Right-click for options";
  chip.appendChild(fileIcon(16));

  const name = document.createElement("span");
  name.className = "claspt-attachment-name";
  name.textContent = words.name;
  chip.appendChild(name);

  const size = document.createElement("span");
  size.className = "claspt-attachment-size";
  size.textContent = `${read.ext.toUpperCase()} · ${formatSize(read.size)}`;
  chip.appendChild(size);

  if (read.sealed) chip.appendChild(lockBadge(true));
  describe(chip, read, words.name);

  // The comment sits under the chip, inside one element so a right-click
  // on it still finds the file.
  let shown: HTMLElement = chip;
  if (words.caption) {
    const figure = document.createElement("span");
    figure.className = "claspt-attachment-figure";
    describe(figure, read, words.name);
    figure.appendChild(chip);
    figure.appendChild(captionEl(words.caption));
    shown = figure;
  }
  img.replaceWith(shown);

  return () => shown.replaceWith(img);
}

/** The attachment under a right-click, if the click landed on one. */
export function attachmentAt(target: EventTarget | null): AttachmentTarget | null {
  if (!(target instanceof Element)) return null;
  const el = target.closest<HTMLElement>("[data-attachment]");
  if (!el) return null;
  const d = el.dataset;
  if (!d.relPath || !d.mdPath) return null;
  return {
    relPath: d.relPath,
    mdPath: d.mdPath,
    sealed: d.sealed === "1",
    name: d.name ?? d.mdPath,
    size: Number(d.size ?? 0),
    ext: d.ext ?? "",
  };
}
