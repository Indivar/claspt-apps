// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { syntaxTree } from "@codemirror/language";
import {
  type Extension,
  type EditorState,
  RangeSetBuilder,
  StateField,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";

/**
 * Line decorations for markdown headings.
 *
 * Uses a **StateField** (not a ViewPlugin) so that decorations are
 * available during CodeMirror's initial DOM construction. This lets
 * CM measure correct line heights on the very first render, keeping
 * the gutter perfectly in sync with heading lines.
 */

const headingLineDecos: Record<number, Decoration> = {
  1: Decoration.line({ class: "cm-heading-line-1" }),
  2: Decoration.line({ class: "cm-heading-line-2" }),
  3: Decoration.line({ class: "cm-heading-line-3" }),
  4: Decoration.line({ class: "cm-heading-line-4" }),
  5: Decoration.line({ class: "cm-heading-line-5" }),
  6: Decoration.line({ class: "cm-heading-line-6" }),
};

function buildHeadingDecorations(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const tree = syntaxTree(state);

  tree.iterate({
    enter(node) {
      const name = node.name;
      let level = 0;
      if (name.startsWith("ATXHeading")) {
        level = parseInt(name.charAt(10), 10);
      } else if (name === "SetextHeading1") {
        level = 1;
      } else if (name === "SetextHeading2") {
        level = 2;
      }
      const deco = headingLineDecos[level];
      if (deco) {
        const line = state.doc.lineAt(node.from);
        builder.add(line.from, line.from, deco);
      }
    },
  });

  return builder.finish();
}

const headingDecoField = StateField.define<DecorationSet>({
  create(state) {
    return buildHeadingDecorations(state);
  },
  update(decos, tr) {
    if (tr.docChanged || syntaxTree(tr.state) !== syntaxTree(tr.startState)) {
      return buildHeadingDecorations(tr.state);
    }
    return decos;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export const headingLineExtension: Extension = headingDecoField;
