// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { FenceTracker } from "@claspt/shared/secret-parser";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  GutterMarker,
  gutter,
} from "@codemirror/view";
import { type EditorState, type Range, StateField } from "@codemirror/state";

/** Line decoration for secret block fence lines (amber background + left border). */
const secretLineDeco = Decoration.line({ class: "cm-secret-line" });

/** Line decoration for secret value lines — masked with bullets. */
const secretValueDeco = Decoration.line({ class: "cm-secret-line cm-secret-value" });

/** Gutter marker showing a lock icon for secret blocks. */
class SecretGutterMarker extends GutterMarker {
  override toDOM() {
    const el = document.createElement("span");
    el.className = "cm-secret-gutter";
    el.textContent = "\u{1F512}";
    return el;
  }
}

const secretMarker = new SecretGutterMarker();

/** Scan the document and apply amber line decorations to all :::secret blocks.
 *  Skips :::secret patterns inside fenced code blocks (``` or ~~~) and
 *  indented code blocks (4+ spaces or tab). */
function buildSecretDecorations(state: EditorState): DecorationSet {
  try {
    return buildSecretDecorationsInner(state);
  } catch (err) {
    console.error("[secret-highlight] buildSecretDecorations failed:", err);
    return Decoration.set([]);
  }
}

function buildSecretDecorationsInner(state: EditorState): DecorationSet {
  const doc = state.doc;
  const decos: Range<Decoration>[] = [];
  let inBlock = false;
  const fence = new FenceTracker();

  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const raw = line.text;
    const text = raw.trim();

    // One rule for fences, shared with the parser that decides what gets
    // encrypted on save, so what this highlights as a secret is what is sealed.
    if (fence.observe(raw)) continue;
    if (fence.isOpen()) continue;

    // Skip indented code blocks (4+ spaces or tab)
    if (raw.length > 0 && (raw.startsWith("    ") || raw.startsWith("\t"))) continue;

    if (text.startsWith(":::secret[")) {
      inBlock = true;
      decos.push(secretLineDeco.range(line.from));
    } else if (inBlock && text === ":::") {
      decos.push(secretLineDeco.range(line.from));
      inBlock = false;
    } else if (inBlock) {
      decos.push(secretValueDeco.range(line.from));
    }
  }

  return Decoration.set(decos, true);
}

/**
 * StateField providing secret block line decorations.
 * Uses ONLY Decoration.line() — no replace, no block widgets, no height
 * changes. This guarantees the gutter always shows continuous line numbers.
 */
const secretDecoField = StateField.define<DecorationSet>({
  create(state) {
    return buildSecretDecorations(state);
  },
  update(decos, tr) {
    if (tr.docChanged) {
      return buildSecretDecorations(tr.state);
    }
    return decos;
  },
  provide(field) {
    return EditorView.decorations.from(field);
  },
});

/** Gutter that shows a lock icon on the opening fence of each secret block. */
const secretGutter = gutter({
  class: "cm-secret-gutter-col",
  lineMarker(view, line) {
    const lineText = view.state.doc.lineAt(line.from).text.trim();
    if (lineText.startsWith(":::secret[")) {
      return secretMarker;
    }
    return null;
  },
});

/** Click handler: when a secret block line is clicked, determine which block
 *  index it belongs to and emit a custom event so the SecretCard panel
 *  can scroll the corresponding card into view. */
const secretClickHandler = EditorView.domEventHandlers({
  click(event, view) {
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos === null) return false;

    const clickedLine = view.state.doc.lineAt(pos);
    const doc = view.state.doc;

    // Walk through the document to find which secret block this line belongs to
    let inBlock = false;
    let blockIndex = -1;
    let clickedBlockIndex = -1;

    for (let i = 1; i <= doc.lines; i++) {
      const line = doc.line(i);
      const text = line.text.trim();

      if (text.startsWith(":::secret[")) {
        inBlock = true;
        blockIndex++;
      }

      if (inBlock && line.from === clickedLine.from) {
        clickedBlockIndex = blockIndex;
        break;
      }

      if (inBlock && text === ":::") {
        inBlock = false;
      }
    }

    if (clickedBlockIndex >= 0) {
      window.dispatchEvent(
        new CustomEvent("claspt:scroll-to-secret", {
          detail: { index: clickedBlockIndex },
        }),
      );
    }

    return false; // don't prevent default click behavior
  },
});

/**
 * Extension bundle for secret block highlighting:
 * - Amber background + left border on all lines within :::secret blocks
 * - Value lines masked with bullets (cm-secret-value)
 * - Lock icon gutter marker on the opening fence line
 * - Click-to-scroll: clicking a secret block scrolls the corresponding card
 * - ZERO replace decorations — gutter line numbers are always continuous
 */
export function secretBlockHighlight() {
  return [secretDecoField, secretGutter, secretClickHandler];
}
