// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { ViewPlugin, type ViewUpdate } from "@codemirror/view";

/**
 * Safety-net extension that forces CodeMirror to re-measure DOM heights
 * after the initial render and after document/decoration changes.
 *
 * This permanently fixes gutter misalignment caused by the combination of:
 *  - Heading line decorations (CSS classes that change fontSize)
 *  - Secret block replace decorations (block widgets replacing multiple lines)
 *
 * CodeMirror's first height measurement can happen before CSS classes are
 * fully applied or before replace widgets are laid out. A single
 * requestMeasure on the next animation frame catches these cases.
 */
export const heightSyncPlugin = ViewPlugin.fromClass(
  class {
    private pending = false;

    constructor(private view: import("@codemirror/view").EditorView) {
      this.scheduleSync();
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.heightChanged || update.viewportChanged) {
        this.scheduleSync();
      }
    }

    private scheduleSync() {
      if (this.pending) return;
      this.pending = true;
      requestAnimationFrame(() => {
        this.pending = false;
        this.view.requestMeasure();
      });
    }
  },
);
