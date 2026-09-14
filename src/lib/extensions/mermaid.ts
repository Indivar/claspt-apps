// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * mermaid.ts — Mermaid diagrams from ```mermaid fenced blocks.
 *
 * Two-phase like most library-backed extensions: the Marked renderer emits an
 * empty `<pre class="mermaid" data-mermaid-source="...">` placeholder, then the
 * post-processor decodes the source, re-inserts it as a clean text node, and runs
 * `mermaid.run()` to swap in SVG. Mermaid is initialized with `securityLevel:
 * "strict"` and re-initialized on theme change. See the note on
 * {@link MERMAID_SVG_TAGS} for why the DOMPurify allowlist deliberately omits
 * `<image>`/`<use>` (remote-fetch / tracking-leak surface).
 */
import type { MarkedExtension, Tokens } from "marked";
import type { MarkdownExtension } from "./types";
import { registerExtension } from "./registry";
import { encodeSource, decodeSource } from "./preview-pipeline";

/** Cached mermaid module reference (lazy-loaded). */
let mermaidMod: typeof import("mermaid") | null = null;

/** Track the theme mermaid was last initialized with. */
let lastTheme: string | null = null;

/**
 * Create a Marked extension that captures ```mermaid blocks.
 * Outputs a <pre class="mermaid"> element whose text content is the diagram
 * source — this is the format mermaid.run() expects.
 */
function markedMermaid(): MarkedExtension {
  return {
    renderer: {
      code(token: Tokens.Code) {
        if (token.lang !== "mermaid") return false;
        // Store source in data attribute — <pre> starts empty (no tall text).
        // Postprocess reads the attribute and sets textContent before mermaid.run().
        return `<pre class="mermaid" data-mermaid-source="${encodeSource(token.text)}"></pre>`;
      },
    },
  };
}

/**
 * Post-processor: use mermaid.run() to render all <pre class="mermaid">
 * elements. Before calling run(), we fix the innerHTML encoding issue:
 * mermaid reads innerHTML which has &gt; for >, breaking arrows like -->.
 * We re-set each node's textContent from its own textContent, which forces
 * the browser to rebuild innerHTML from the clean text.
 */
function postprocess(container: HTMLElement): (() => void) | void {
  if (!mermaidMod) return;

  const nodes = container.querySelectorAll<HTMLPreElement>(
    "pre.mermaid:not([data-processed])",
  );
  if (nodes.length === 0) return;

  const mermaid = mermaidMod.default;

  // Re-initialize when the theme changes
  const isDark = document.documentElement.classList.contains("dark");
  const currentTheme = isDark ? "dark" : "default";
  if (lastTheme !== currentTheme) {
    mermaid.initialize({
      startOnLoad: false,
      theme: currentTheme,
      securityLevel: "strict",
    });
    lastTheme = currentTheme;
  }

  // Read source from data attribute and set as a clean text node.
  // mermaid.run() reads innerHTML — a text node ensures no HTML entities.
  for (const node of nodes) {
    const src = node.getAttribute("data-mermaid-source");
    if (src) {
      const decoded = decodeSource(src);
      while (node.firstChild) node.removeChild(node.firstChild);
      node.appendChild(document.createTextNode(decoded));
      node.removeAttribute("data-mermaid-source");
    }
  }

  // mermaid.run() processes the nodes synchronously (replaces text with SVG)
  mermaid.run({ nodes: Array.from(nodes) }).catch((err: unknown) => {
    console.error("[mermaid] run failed:", err);
  });
}

/** SVG tags and attributes that mermaid output uses.
 *
 * Security: these widen the GLOBAL DOMPurify allowlist for note markdown. We
 * deliberately do NOT include `image`/`use` (or `xlink:href`): mermaid renders
 * its own SVG via the post-processor (`mermaid.run()`), which runs AFTER the
 * central sanitizer and injects directly into the DOM — so mermaid diagrams do
 * not depend on this allowlist. Allowing `<image>`/`<use>` here would instead
 * let a raw `<image xlink:href="https://attacker/…">` typed into any note
 * survive sanitization and fetch a remote resource on preview (IP/tracking
 * leak). Keep only inert, no-fetch SVG primitives. */
const MERMAID_SVG_TAGS = [
  "svg",
  "g",
  "path",
  "circle",
  "rect",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "marker",
  "defs",
  "clipPath",
  "switch",
  "title",
  "desc",
  "linearGradient",
  "radialGradient",
  "stop",
  "pattern",
  "mask",
];

const MERMAID_SVG_ATTRS = [
  "viewBox",
  "xmlns",
  "xmlns:xlink",
  "fill",
  "stroke",
  "stroke-width",
  "stroke-dasharray",
  "stroke-linecap",
  "stroke-linejoin",
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
  "dominant-baseline",
  "font-size",
  "font-family",
  "font-weight",
  "opacity",
  "clip-path",
  "marker-end",
  "marker-start",
  "points",
  "refX",
  "refY",
  "markerWidth",
  "markerHeight",
  "orient",
  "preserveAspectRatio",
  "offset",
  "stop-color",
  "stop-opacity",
  "gradientTransform",
  "gradientUnits",
  "patternUnits",
  "dx",
  "dy",
  "data-mermaid-source",
];

/** Mermaid extension — ```mermaid fenced code blocks rendered as SVG diagrams. */
const mermaidExtension: MarkdownExtension = {
  id: "mermaid",
  name: "Mermaid Diagrams",
  description: "```mermaid flowcharts, sequence diagrams, Gantt charts",
  category: "diagrams",
  defaultEnabled: true,
  toolbarInsert: "```mermaid\ngraph TD\n  A[Start] --> B[End]\n```",
  toolbarOrder: 70,
  iconPath: "M4 4h16v2H4V4zm0 4h10v2H4V8zm0 4h16v2H4v-2zm0 4h10v2H4v-2z",

  markedExtension: () => markedMermaid(),
  postprocess,
  purifyTags: MERMAID_SVG_TAGS,
  purifyAttrs: MERMAID_SVG_ATTRS,

  load: async () => {
    if (mermaidMod) return;
    mermaidMod = await import("mermaid");
  },
};

registerExtension(mermaidExtension);

export default mermaidExtension;
