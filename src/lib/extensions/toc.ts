// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * toc.ts — auto-generated table of contents from a `[[toc]]` placeholder.
 *
 * A block-level Marked tokenizer replaces `[[toc]]` with a nested list built from
 * the document's headings (linking to their anchors). Note the interplay with
 * wikilinks: the wikilink preprocessor explicitly skips `[[toc]]` so this
 * extension can claim it.
 */
import type { MarkedExtension, Token } from "marked";
import type { MarkdownExtension } from "./types";
import { registerExtension } from "./registry";

/** Create a Marked extension that replaces [[toc]] with a generated table of contents. */
function markedToc(): MarkedExtension {
  return {
    extensions: [
      {
        name: "toc-placeholder",
        level: "block",
        start(src: string) {
          return src.match(/\[\[toc\]\]/i)?.index;
        },
        tokenizer(src: string) {
          const match = src.match(/^\[\[toc\]\]/i);
          if (!match) return undefined;
          return {
            type: "toc-placeholder",
            raw: match[0],
          } as Token;
        },
        renderer() {
          // Emit a placeholder that will be filled by the postprocess hook
          return '<nav class="toc-block" data-toc="true"><em>Generating table of contents\u2026</em></nav>';
        },
      },
    ],
    hooks: {
      postprocess(html: string): string {
        // Only process if there's a TOC placeholder
        if (!html.includes('data-toc="true"')) return html;

        // Collect headings from the rendered HTML
        const headingRegex = /<h([1-6])[^>]*>(.*?)<\/h[1-6]>/gi;
        const headings: { level: number; text: string; id: string }[] = [];
        let m: ReturnType<RegExp["exec"]>;
        while ((m = headingRegex.exec(html)) !== null) {
          const level = parseInt(m[1]!, 10);
          // Strip HTML tags from heading text
          const text = m[2]!.replace(/<[^>]*>/g, "");
          const id = text
            .toLowerCase()
            .replace(/[^\w\s-]/g, "")
            .replace(/\s+/g, "-");
          headings.push({ level, text, id });
        }

        if (headings.length === 0) return html;

        // Build the TOC list
        const minLevel = Math.min(...headings.map((h) => h.level));
        const items = headings
          .map((h) => {
            const indent = h.level - minLevel;
            const pad = "  ".repeat(indent);
            return `${pad}<li><a href="#${h.id}" class="toc-link">${h.text}</a></li>`;
          })
          .join("\n");

        const tocHtml = `<nav class="toc-block"><div class="toc-title">Table of Contents</div><ul>\n${items}\n</ul></nav>`;

        // Add IDs to headings and replace the placeholder
        let result = html;
        for (const h of headings) {
          // Add id to the first matching heading without an id
          result = result.replace(
            new RegExp(`(<h${h.level})([^>]*>)`, "i"),
            `$1 id="${h.id}"$2`,
          );
        }

        return result.replace(
          /<nav class="toc-block" data-toc="true">.*?<\/nav>/,
          tocHtml,
        );
      },
    },
  };
}

/** TOC extension — [[toc]] generates a navigable table of contents. */
const tocExtension: MarkdownExtension = {
  id: "toc",
  name: "Table of Contents",
  description: "[[toc]] auto-generates a navigable heading list",
  category: "document",
  defaultEnabled: false,
  toolbarInsert: "[[toc]]",
  toolbarOrder: 90,
  iconPath:
    "M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z",

  markedExtension: () => markedToc(),
};

registerExtension(tocExtension);

export default tocExtension;
