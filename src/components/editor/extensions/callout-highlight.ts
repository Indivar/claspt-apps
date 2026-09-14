// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * CM6 StateField: highlights callout blockquote lines with colored left border.
 * Detects `> [!type]` patterns and applies line decorations.
 */
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { type EditorState, type Range, StateField } from "@codemirror/state";

/** Map callout type to CSS color for the left border. */
const CALLOUT_COLORS: Record<string, string> = {
  note: "#448aff",
  info: "#448aff",
  tip: "#00c853",
  success: "#00c853",
  warning: "#ff9100",
  danger: "#ff1744",
  bug: "#ff1744",
  question: "#aa00ff",
  example: "#aa00ff",
  quote: "#78909c",
};

/** Build decorations for callout lines. */
function buildCalloutDecos(state: EditorState): DecorationSet {
  const doc = state.doc;
  const decos: Range<Decoration>[] = [];
  let activeColor: string | null = null;

  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const text = line.text;

    // Check for callout opener: > [!type]
    const calloutMatch = text.match(
      /^>\s*\[!(note|info|tip|success|warning|danger|bug|question|example|quote)\]/i,
    );

    if (calloutMatch) {
      const type = calloutMatch[1]!.toLowerCase();
      activeColor = CALLOUT_COLORS[type] ?? "#448aff";
      decos.push(
        Decoration.line({
          attributes: {
            style: `border-left: 3px solid ${activeColor}; padding-left: 8px;`,
          },
        }).range(line.from),
      );
    } else if (activeColor && text.startsWith(">")) {
      // Continuation line of the callout blockquote
      decos.push(
        Decoration.line({
          attributes: {
            style: `border-left: 3px solid ${activeColor}; padding-left: 8px; opacity: 0.85;`,
          },
        }).range(line.from),
      );
    } else {
      // No longer inside a callout
      activeColor = null;
    }
  }

  return Decoration.set(decos, true);
}

/** StateField for callout line decorations. */
export const calloutHighlightField = StateField.define<DecorationSet>({
  create(state) {
    return buildCalloutDecos(state);
  },
  update(decos, tr) {
    if (tr.docChanged) {
      return buildCalloutDecos(tr.state);
    }
    return decos;
  },
  provide(field) {
    return EditorView.decorations.from(field);
  },
});
