// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * graphviz.ts — Graphviz/DOT diagrams from ```dot / ```graphviz blocks.
 *
 * Renders DOT source to SVG with Viz.js (WASM, lazy-loaded). Because Viz.js
 * produces raw SVG markup, the post-processor runs its output through DOMPurify
 * before inserting it into the placeholder div.
 */
import type { MarkedExtension, Tokens } from "marked";
import type { MarkdownExtension } from "./types";
import { registerExtension } from "./registry";
import DOMPurify from "dompurify";
import { encodeSource, decodeSource } from "./preview-pipeline";

/** Cached Viz.js instance (lazy-loaded, WASM). */
let vizInstance: { renderString: (src: string, options?: object) => string } | null =
  null;

/** Create a Marked extension that captures ```dot / ```graphviz blocks. */
function markedGraphviz(): MarkedExtension {
  return {
    renderer: {
      code(token: Tokens.Code) {
        if (token.lang !== "dot" && token.lang !== "graphviz") return false;
        return `<div class="graphviz-block" data-graphviz-source="${encodeSource(token.text)}"><div class="graphviz-loading">Loading diagram\u2026</div></div>`;
      },
    },
  };
}

/**
 * Post-processor: render DOT source to SVG via Viz.js WASM.
 *
 * Safety: Viz.js produces sanitized SVG output from DOT language input.
 * Error messages use safe DOM methods. The parent HTML has already been
 * sanitized through DOMPurify in renderMarkdown().
 */
function postprocess(container: HTMLElement): void {
  const blocks = container.querySelectorAll<HTMLDivElement>(
    ".graphviz-block[data-graphviz-source]",
  );
  if (blocks.length === 0) return;

  if (!vizInstance) {
    // WASM failed to load — show error instead of eternal "Loading..."
    for (const block of blocks) {
      block.textContent = "";
      const errDiv = document.createElement("div");
      errDiv.className = "graphviz-error";
      errDiv.textContent = "Graphviz: failed to load rendering engine (WASM)";
      block.appendChild(errDiv);
    }
    return;
  }

  for (const block of blocks) {
    const source = decodeSource(block.getAttribute("data-graphviz-source") ?? "");
    if (!source) continue;

    try {
      const rawSvg = vizInstance.renderString(source, { format: "svg", engine: "dot" });
      const cleanSvg = DOMPurify.sanitize(rawSvg, {
        USE_PROFILES: { svg: true, svgFilters: true },
        ADD_TAGS: GV_SVG_TAGS,
        ADD_ATTR: GV_SVG_ATTRS,
      });
      // Safe: DOMPurify-sanitized SVG output
      block.innerHTML = cleanSvg; // eslint-disable-line no-unsanitized/property -- DOMPurify sanitized
      block.classList.add("graphviz-rendered");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      block.textContent = "";
      const errDiv = document.createElement("div");
      errDiv.className = "graphviz-error";
      const strong = document.createElement("strong");
      strong.textContent = "Graphviz error";
      const pre = document.createElement("pre");
      pre.textContent = msg;
      errDiv.appendChild(strong);
      errDiv.appendChild(pre);
      block.appendChild(errDiv);
      block.classList.add("graphviz-error-state");
    }
  }
}

/**
 * SVG tags/attrs used by Graphviz output.
 *
 * These are passed to the LOCAL `DOMPurify.sanitize` call in `postprocess`
 * (`ADD_TAGS`/`ADD_ATTR`) that cleans Viz.js's raw SVG before it is inserted.
 * They are deliberately NOT exported as the extension's `purifyTags`/
 * `purifyAttrs`: the central preview sanitizer never sees Graphviz output (it is
 * injected post-sanitize here), so widening the global allowlist with `<use>`
 * etc. would only add dormant XSS surface for raw SVG typed in other markdown.
 */
const GV_SVG_TAGS = [
  "svg",
  "g",
  "path",
  "circle",
  "ellipse",
  "rect",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "title",
  "defs",
  "clipPath",
  "use",
];

const GV_SVG_ATTRS = [
  "viewBox",
  "xmlns",
  "fill",
  "stroke",
  "stroke-width",
  "d",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "width",
  "height",
  "transform",
  "text-anchor",
  "font-size",
  "font-family",
  "points",
  "data-graphviz-source",
];

/** Graphviz extension — ```dot / ```graphviz fenced blocks rendered as SVG. */
const graphvizExtension: MarkdownExtension = {
  id: "graphviz",
  name: "Graphviz",
  description: "```dot / ```graphviz DOT diagrams rendered to SVG",
  category: "diagrams",
  defaultEnabled: false,
  toolbarInsert: "```dot\ndigraph G {\n  A -> B -> C;\n}\n```",
  toolbarOrder: 85,
  iconPath:
    "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z",

  markedExtension: () => markedGraphviz(),
  postprocess,

  load: async () => {
    if (vizInstance) return;
    try {
      const mod = await import("@viz-js/viz");
      vizInstance = await mod.instance();
    } catch (err) {
      console.error("[graphviz] Failed to load Viz.js WASM:", err);
    }
  },
};

registerExtension(graphvizExtension);

export default graphvizExtension;
