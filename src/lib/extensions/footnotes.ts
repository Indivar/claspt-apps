// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * footnotes.ts — reference-style footnotes (`[^1]` markers, `[^1]:` definitions).
 *
 * Thin wrapper over the `marked-footnote` extension, lazy-loaded on first use.
 */
import type { MarkedExtension } from "marked";
import type { MarkdownExtension } from "./types";
import { registerExtension } from "./registry";

/** Cached reference to the loaded marked-footnote module. */
let cachedMarkedFootnote: ((options?: object) => MarkedExtension) | null = null;

/** Footnotes extension — [^1] inline references and [^1]: definitions. */
const footnotesExtension: MarkdownExtension = {
  id: "footnotes",
  name: "Footnotes",
  description: "[^1] reference-style footnotes",
  category: "core",
  defaultEnabled: true,
  toolbarInsert: "[^1]",
  toolbarOrder: 60,
  iconPath:
    "M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z",

  markedExtension: () => {
    if (!cachedMarkedFootnote) {
      throw new Error("Footnotes extension not loaded — call load() first");
    }
    return cachedMarkedFootnote();
  },

  load: async () => {
    if (cachedMarkedFootnote) return;
    const mod = await import("marked-footnote");
    cachedMarkedFootnote = mod.default;
  },
};

registerExtension(footnotesExtension);

export default footnotesExtension;
