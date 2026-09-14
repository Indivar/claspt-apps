// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * music.ts — musical notation from ```abc / ```music blocks (ABC notation).
 *
 * The Marked renderer emits a placeholder div; the post-processor lazy-loads
 * abcjs and renders the ABC source into staff notation. abcjs draws its own SVG
 * after sanitization, so no allowlist widening is required.
 */
import type { MarkedExtension, Tokens } from "marked";
import type { MarkdownExtension } from "./types";
import { registerExtension } from "./registry";
import { encodeSource, decodeSource } from "./preview-pipeline";

/** Cached reference to abcjs module. */
let abcjs: typeof import("abcjs") | null = null;

/** Marked renderer: capture ```abc / ```music fenced blocks → placeholder divs. */
function markedMusic(): MarkedExtension {
  return {
    renderer: {
      code(token: Tokens.Code) {
        if (token.lang !== "abc" && token.lang !== "music") return false;
        return `<div class="abc-block" data-abc-source="${encodeSource(token.text)}"><div class="abc-loading">Loading music…</div></div>`;
      },
    },
  };
}

/** Music (ABC) extension — ABC music notation rendered to SVG via abcjs. */
const musicExtension: MarkdownExtension = {
  id: "music",
  name: "Music (ABC)",
  description: "ABC music notation rendered to SVG",
  category: "media",
  defaultEnabled: false,
  toolbarInsert: "```abc\nX:1\nT:Title\nM:4/4\nK:C\nCDEF GABc|\n```",
  toolbarOrder: 70,
  iconPath:
    "M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z",

  markedExtension: () => markedMusic(),

  load: async () => {
    if (abcjs) return;
    abcjs = await import("abcjs");
  },

  postprocess: (container: HTMLElement) => {
    if (!abcjs) return;
    const blocks = container.querySelectorAll<HTMLElement>(".abc-block");
    for (const block of blocks) {
      const raw = block.dataset.abcSource;
      if (!raw) continue;
      const source = decodeSource(raw);

      block.textContent = "";
      const renderDiv = document.createElement("div");
      renderDiv.className = "abc-render";
      block.appendChild(renderDiv);

      try {
        abcjs.renderAbc(renderDiv, source, {
          responsive: "resize",
          staffwidth: 600,
        });
      } catch (e) {
        const err = document.createElement("div");
        err.className = "abc-error";
        err.textContent = `ABC error: ${e instanceof Error ? e.message : String(e)}`;
        block.textContent = "";
        block.appendChild(err);
      }
    }
  },

  // No `purifyTags`/`purifyAttrs`: abcjs draws its staff notation directly into
  // the render div via the DOM, so its SVG never passes through the central
  // preview sanitizer. Declaring a global SVG allowlist here would not affect
  // music rendering and would only widen the sanitizer for raw SVG typed in
  // other markdown — dormant XSS surface (e.g. `<use>`) for no benefit.
};

registerExtension(musicExtension);

export default musicExtension;
