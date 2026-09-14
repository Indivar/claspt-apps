// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * math.ts — LaTeX math rendering via KaTeX (`$...$` inline, `$$...$$` block).
 *
 * Wraps `marked-katex-extension`, lazy-loading both KaTeX's CSS and the extension
 * on first use. Widens the DOMPurify allowlist with the MathML tags/attributes
 * KaTeX emits so the rendered output survives sanitization. The `chemical`
 * extension depends on this one (mhchem is a KaTeX addon).
 */
import type { MarkedExtension } from "marked";
import type { MarkdownExtension } from "./types";
import { registerExtension } from "./registry";

/** Cached reference to the loaded marked-katex-extension module. */
let cachedMarkedKatex: ((options?: object) => MarkedExtension) | null = null;

/** Math (KaTeX) extension — inline $...$ and block $$...$$ formulas. */
const mathExtension: MarkdownExtension = {
  id: "math",
  name: "Math (KaTeX)",
  description: "Inline $...$ and block $$...$$ formulas",
  category: "core",
  defaultEnabled: true,
  toolbarInsert: "$$\n\n$$",
  toolbarOrder: 10,
  iconPath:
    "M4.5 7h2.22L8.5 11.44 10.28 7H12l-2.78 5L12 17h-2.22L8.5 12.56 6.72 17H5l2.78-5L5 7zM19 7h-5v2h3l-4 4v2h5v-2h-3l4-4V7z",

  markedExtension: () => {
    if (!cachedMarkedKatex) {
      throw new Error("Math extension not loaded — call load() first");
    }
    return cachedMarkedKatex({ throwOnError: false });
  },

  load: async () => {
    if (cachedMarkedKatex) return;
    // Load KaTeX CSS
    if (!document.querySelector('link[href*="katex"]')) {
      const katexModule = await import("katex/dist/katex.min.css");
      void katexModule;
    }
    // Load the marked extension (this imports katex internally)
    const mod = await import("marked-katex-extension");
    cachedMarkedKatex = mod.default;
  },

  purifyTags: [
    "math",
    "semantics",
    "mrow",
    "mi",
    "mo",
    "mn",
    "msup",
    "msub",
    "mfrac",
    "mover",
    "munder",
    "mtable",
    "mtr",
    "mtd",
    "annotation",
    "mspace",
    "mtext",
    "menclose",
    "mpadded",
    "msqrt",
    "mroot",
  ],
  purifyAttrs: [
    "mathvariant",
    "encoding",
    "xmlns",
    "displaystyle",
    "scriptlevel",
    "columnalign",
    "rowalign",
    "columnspacing",
    "rowspacing",
    "fence",
    "stretchy",
    "symmetric",
    "lspace",
    "rspace",
    "accent",
    "accentunder",
  ],
};

registerExtension(mathExtension);

export default mathExtension;
