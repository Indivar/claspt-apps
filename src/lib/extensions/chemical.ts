// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * chemical.ts — chemical equations via KaTeX's mhchem addon (`\ce{...}`).
 *
 * Has no Marked hook of its own: it depends on the `math` extension and simply
 * registers mhchem's `\ce` macro onto the *shared* KaTeX instance at load time.
 * See the load() comment for why it imports the mhchem source file rather than
 * the standalone dist bundle (the bundle ships its own throwaway KaTeX copy).
 */
import type { MarkdownExtension } from "./types";
import { registerExtension } from "./registry";

/** Chemical (mhchem) extension — uses KaTeX's mhchem package for chemical formulas.
 *
 * Syntax: $\ce{H2O}$ for inline, $$\ce{2H2 + O2 -> 2H2O}$$ for block.
 * Depends on the math (KaTeX) extension being enabled — mhchem is a KaTeX addon.
 */
const chemicalExtension: MarkdownExtension = {
  id: "chemical",
  name: "Chemical (mhchem)",
  description: "$\\ce{H2O}$ chemical formulas via KaTeX mhchem",
  category: "science",
  defaultEnabled: false,
  toolbarInsert: "$\\ce{H2O}$",
  toolbarOrder: 15,
  iconPath:
    "M5 15v-3h3v-2H5V7H3v3H0v2h3v3h2zm7-1.12L9.26 17.3c-.57.7-.09 1.7.82 1.7h7.84c.91 0 1.39-1 .82-1.7L16 13.88V9h1V7h-6v2h1v4.88zM13 9h2v5.5l1.7 2.5h-5.4l1.7-2.5V9z",
  dependsOn: ["math"],

  load: async () => {
    const { ensureLoaded } = await import("./registry");
    await ensureLoaded("math");
    // CRITICAL: import the SOURCE mhchem file, NOT the dist bundle.
    // katex/dist/contrib/mhchem.mjs is a standalone 15K-line bundle with
    // its OWN copy of KaTeX — __defineMacro registers on a throwaway instance.
    // The source file (contrib/mhchem/mhchem.js) does `import katex from "katex"`
    // and registers \ce on the SHARED katex instance.
    await import("katex/contrib/mhchem/mhchem.js");
  },

  // No markedExtension needed — the math extension handles $...$ and $$...$$
  // mhchem just adds \ce{} recognition to KaTeX's parser

  // Uses same purify tags/attrs as math extension (inherited via dependency)
};

registerExtension(chemicalExtension);

export default chemicalExtension;
