// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * wikilinks.ts — internal page links using `[[Page Title]]` / `[[Title|Display]]`.
 *
 * A preprocessor rewrites the `[[...]]` syntax into `<a class="wikilink">` anchors
 * (carrying the target title in a data attribute), and a postprocessor wires up
 * click handlers that resolve the title to a page path via the pages store and
 * navigate. `[[toc]]` is intentionally excluded so the `toc` extension owns it.
 */
import type { MarkdownExtension } from "./types";
import { registerExtension } from "./registry";
import { encodeAttr } from "./preview-pipeline";

/**
 * Pre-processor: convert [[Page Title]] and [[Page Title|Display]] syntax
 * into anchor tags before Marked parsing.
 */
function preprocess(content: string): string {
  // Match [[target]] and [[target|display]], but skip [[toc]] for the TOC extension
  return content.replace(
    /\[\[(?!toc\]\])([^\]|]+?)(?:\|([^\]]+?))?\]\]/gi,
    (_match, target: string, display?: string) => {
      const title = target.trim();
      const text = display?.trim() || title;
      return `<a class="wikilink" data-page-title="${encodeAttr(title)}">${encodeAttr(text)}</a>`;
    },
  );
}

/**
 * Post-processor: attach click handlers to wikilink anchors.
 * Resolves page title to path via pages store and navigates.
 */
function postprocess(container: HTMLElement): (() => void) | void {
  const links = container.querySelectorAll<HTMLAnchorElement>(
    "a.wikilink[data-page-title]",
  );
  if (links.length === 0) return;

  const handler = (e: Event) => {
    e.preventDefault();
    const link = e.currentTarget as HTMLAnchorElement;
    const title = link.getAttribute("data-page-title");
    if (!title) return;

    // Lazy import to avoid circular dependency at module load
    import("@/stores/pages-store").then(({ usePagesStore }) => {
      const state = usePagesStore.getState();
      // Case-insensitive title match
      const target = state.pages.find(
        (p) => p.meta.title.toLowerCase() === title.toLowerCase(),
      );
      if (target) {
        state.openPage(target.path);
      }
    });
  };

  for (const link of links) {
    link.addEventListener("click", handler);
  }

  return () => {
    for (const link of links) {
      link.removeEventListener("click", handler);
    }
  };
}

/** Wiki-links extension — [[Page Title]] cross-references. */
const wikilinksExtension: MarkdownExtension = {
  id: "wikilinks",
  name: "Wiki-links",
  description: "[[Page Title]] cross-references between pages",
  category: "core",
  defaultEnabled: true,
  toolbarInsert: "[[",
  toolbarOrder: 55,
  iconPath:
    "M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z",

  preprocess,
  postprocess,
  purifyAttrs: ["data-page-title"],
};

registerExtension(wikilinksExtension);

export default wikilinksExtension;
