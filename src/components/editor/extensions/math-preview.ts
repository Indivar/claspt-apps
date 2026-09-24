// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * CM6 ViewPlugin: renders inline KaTeX previews for $...$ math expressions
 * when the cursor is NOT inside the expression. Block $$...$$ is not
 * previewed inline since the preview pane handles it better.
 */
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";

/** Widget that renders a KaTeX formula inline. */
class MathWidget extends WidgetType {
  constructor(readonly formula: string) {
    super();
  }

  override toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-math-preview";
    try {
      const katex = (window as unknown as Record<string, unknown>).__katex as
        { renderToString: (s: string, opts: object) => string } | undefined;
      if (katex) {
        // eslint-disable-next-line no-unsanitized/property -- KaTeX renderToString output; runs with trust:false and emits no raw HTML.
        span.innerHTML = katex.renderToString(this.formula, {
          throwOnError: false,
          displayMode: false,
        });
      } else {
        span.textContent = `$${this.formula}$`;
      }
    } catch {
      span.textContent = `$${this.formula}$`;
    }
    return span;
  }

  override eq(other: MathWidget): boolean {
    return this.formula === other.formula;
  }
}

/** Find inline $...$ math and create replace decorations when cursor is outside. */
function buildMathDecos(view: EditorView): DecorationSet {
  const { doc, selection } = view.state;
  const cursor = selection.main.head;
  const decos: { from: number; to: number; deco: Decoration }[] = [];

  // Simple regex scan for inline $...$ (not $$)
  const text = doc.toString();
  const re = /(?<!\$)\$(?!\$)(.+?)(?<!\$)\$(?!\$)/g;
  let found: ReturnType<RegExp["exec"]>;

  while ((found = re.exec(text)) !== null) {
    const from = found.index;
    const to = from + found[0].length;
    const formula = found[1]!;

    // Don't replace if cursor is inside this range
    if (cursor >= from && cursor <= to) continue;

    // Skip if formula is empty or looks like a price ($5)
    if (!formula.trim() || /^\d/.test(formula.trim())) continue;

    decos.push({
      from,
      to,
      deco: Decoration.replace({ widget: new MathWidget(formula) }),
    });
  }

  return Decoration.set(
    decos.map((d) => d.deco.range(d.from, d.to)),
    true,
  );
}

/** ViewPlugin for math preview decorations. */
export const mathPreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildMathDecos(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet) {
        this.decorations = buildMathDecos(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

/**
 * Store the KaTeX reference globally so the widget can access it synchronously.
 * Call this after KaTeX has been loaded by the math extension.
 */
export function setKatexRef(katex: {
  renderToString: (s: string, opts: object) => string;
}): void {
  (window as unknown as Record<string, unknown>).__katex = katex;
}
