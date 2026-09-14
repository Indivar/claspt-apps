// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * CodeMirrorEditor — the core markdown editing surface for a Claspt page.
 *
 * Wraps a CodeMirror 6 EditorView with the app's markdown language support,
 * custom extensions (secret-block highlighting, heading line sizing, math/
 * callout/wikilink plugins), theme, and image paste/drop handling. The parent
 * owns the document string; this component reports edits back via `onChange`
 * and exposes the live view through the shared `editor-api` module so toolbar
 * buttons and the context menu can drive it.
 */
import { useCallback, useEffect, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import {
  highlightSelectionMatches,
  search,
  SearchQuery,
  setSearchQuery,
  findNext,
  searchKeymap,
} from "@codemirror/search";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
} from "@codemirror/autocomplete";
import { clasptTheme } from "./theme";
import { secretBlockHighlight } from "./secret-highlight";
import { mathPreviewPlugin } from "./extensions/math-preview";
import { wikilinkCompletionSource } from "./extensions/wikilink-autocomplete";
import { calloutHighlightField } from "./extensions/callout-highlight";
import { headingLineExtension } from "./extensions/heading-lines";
import { setActiveView, insertImageMarkdown } from "./editor-api";
import { EditorContextMenu } from "./EditorContextMenu";
import { usePagesStore } from "@/stores/pages-store";
import { useExtensionStore } from "@/stores/extension-store";
import { saveMedia } from "@/lib/commands";

/** Build CM6 extension plugins based on the current extension enabled map. */
function buildExtensionPlugins(enabledMap: Record<string, boolean>): Extension[] {
  const plugins: Extension[] = [];
  if (enabledMap.math) plugins.push(mathPreviewPlugin);
  if (enabledMap.callouts) plugins.push(calloutHighlightField);
  if (enabledMap.wikilinks) {
    plugins.push(autocompletion({ override: [wikilinkCompletionSource] }));
  }
  return plugins;
}

interface CodeMirrorEditorProps {
  value: string;
  onChange: (value: string) => void;
  fontSize?: number;
  fontFamily?: string;
  searchHighlight?: string | null;
  onSearchHighlightApplied?: () => void;
  /** Ref that receives the CM6 internal scroll DOM element for scroll sync. */
  scrollDomRef?: React.MutableRefObject<HTMLElement | null>;
}

/**
 * Renders the CodeMirror markdown editor and keeps it in sync with props.
 * The EditorView is created once on mount; font settings, search highlights,
 * and toggled extensions are pushed in afterward via effects rather than by
 * recreating the view.
 */
export default function CodeMirrorEditor({
  value,
  onChange,
  fontSize,
  fontFamily,
  searchHighlight,
  onSearchHighlightApplied,
  scrollDomRef,
}: CodeMirrorEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView>();
  const onChangeRef = useRef(onChange);
  // Compartment wraps the toggleable extension plugins so they can be swapped
  // live (via dispatch/reconfigure) without tearing down the whole EditorView.
  const extensionCompartment = useRef(new Compartment());

  // Keep callback ref up to date without recreating editor
  onChangeRef.current = onChange;

  const createEditor = useCallback(() => {
    if (!containerRef.current) return;

    // Clean up previous instance
    viewRef.current?.destroy();

    // ── Layer 1: Pre-set CSS custom properties BEFORE creating EditorView ──
    // CM6 measures line heights synchronously during construction.
    // If CSS variables aren't set yet, it uses fallback values (e.g. 15px)
    // and the gutter heights will be wrong.
    const el = containerRef.current;
    if (fontSize) el.style.setProperty("--editor-font-size", `${fontSize}px`);
    if (fontFamily) {
      const safe = fontFamily.replace(/['"\\;{}]/g, "");
      el.style.setProperty("--editor-font-family", `'${safe}', monospace`);
    }

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        onChangeRef.current(update.state.doc.toString());
      }
    });

    // Build extension-dependent CM6 plugins (wrapped in compartment for live reconfiguration)
    const extMap = useExtensionStore.getState().enabledMap;
    const extensionPlugins = buildExtensionPlugins(extMap);

    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        history(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        autocompletion(),
        search({ top: true }),
        highlightSelectionMatches(),
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        secretBlockHighlight(),
        headingLineExtension,
        extensionCompartment.current.of(extensionPlugins),
        clasptTheme,
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          ...closeBracketsKeymap,
          indentWithTab,
        ]),
        updateListener,
        EditorView.lineWrapping,
      ],
    });

    viewRef.current = new EditorView({
      state,
      parent: el,
    });
    setActiveView(viewRef.current);
    if (scrollDomRef) scrollDomRef.current = viewRef.current.scrollDOM;

    // ── Layer 2: Robust post-mount remeasure ──
    // WebKit (Tauri WebView) may not have computed styles ready during a
    // single requestAnimationFrame. We use three complementary strategies:
    const view = viewRef.current;
    // (a) Double-rAF: the second frame is guaranteed to run after the
    //     browser has painted at least once, so CSS is fully applied.
    requestAnimationFrame(() => requestAnimationFrame(() => view.requestMeasure()));
    // (b) Font loading: system font fallback resolution can be async and
    //     change actual glyph metrics / line heights after initial render.
    document.fonts.ready.then(() => view.requestMeasure());
    // (c) Safety net for any remaining WebKit edge cases.
    setTimeout(() => view.requestMeasure(), 200);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on mount
  }, []);

  // Create editor on mount
  useEffect(() => {
    createEditor();
    return () => {
      viewRef.current?.destroy();
      setActiveView(null);
      if (scrollDomRef) scrollDomRef.current = null;
    };
  }, [createEditor]); // eslint-disable-line react-hooks/exhaustive-deps

  // Dynamically reconfigure extension plugins when toggled in settings.
  // Subscribes to the extension store and pushes a compartment reconfigure
  // effect so enabling/disabling math, callouts, or wikilinks takes effect
  // without recreating the editor (which would lose cursor/undo history).
  useEffect(() => {
    const unsub = useExtensionStore.subscribe((state) => {
      if (viewRef.current) {
        const newPlugins = buildExtensionPlugins(state.enabledMap);
        viewRef.current.dispatch({
          effects: extensionCompartment.current.reconfigure(newPlugins),
        });
      }
    });
    return unsub;
  }, []);

  // ── Layer 4: Remeasure on container resize ──
  // With `lineWrapping` on, changing the editor width (e.g. toggling Edit <->
  // Split, which halves the pane) re-wraps long lines so each logical line spans
  // a different number of visual rows. If CM6's height cache isn't refreshed the
  // gutter line numbers keep their old heights and drift out of sync with the
  // wrapped content (numbers stack above the text). A ResizeObserver forces a
  // remeasure whenever the editor's box changes size.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const view = viewRef.current;
      if (view) requestAnimationFrame(() => view.requestMeasure());
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── Layer 3: Sync font settings + remeasure on change ──
  // When font settings change after mount (e.g. user changes font size in
  // settings), update the CSS variables and force CM6 to remeasure.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (fontSize) el.style.setProperty("--editor-font-size", `${fontSize}px`);
    if (fontFamily) {
      const safeFontFamily = fontFamily.replace(/['"\\;{}]/g, "");
      el.style.setProperty("--editor-font-family", `'${safeFontFamily}', monospace`);
    }
    // Double-rAF remeasure: CSS variable change affects line heights,
    // CM6 must recalculate after the browser applies the new styles.
    const view = viewRef.current;
    if (view) {
      requestAnimationFrame(() => requestAnimationFrame(() => view.requestMeasure()));
    }
  }, [fontSize, fontFamily]);

  // Apply search highlight from search panel navigation
  useEffect(() => {
    const view = viewRef.current;
    if (!searchHighlight || !view) return;

    requestAnimationFrame(() => {
      const sq = new SearchQuery({
        search: searchHighlight,
        caseSensitive: false,
        literal: true,
      });
      view.dispatch({
        effects: setSearchQuery.of(sq),
        selection: { anchor: 0 },
      });
      findNext(view);
      onSearchHighlightApplied?.();
    });
  }, [searchHighlight, onSearchHighlightApplied]);

  // Paste + Drop image handlers
  const folder = usePagesStore((s) => s.activePage?.meta.folder ?? "general");

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const ALLOWED_TYPES = [
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "image/svg+xml",
      "application/pdf",
    ];

    async function handleImageFiles(files: File[]) {
      for (const file of files) {
        const ext = file.name.split(".").pop()?.toLowerCase() ?? "png";
        const buf = await file.arrayBuffer();
        const data = Array.from(new Uint8Array(buf));
        try {
          const mf = await saveMedia(folder, data, ext);
          const alt = file.name.replace(/\.[^.]+$/, "");
          insertImageMarkdown(alt, mf.md_path);
        } catch (err) {
          console.error("Failed to save media:", err);
        }
      }
    }

    function onPaste(e: ClipboardEvent) {
      const items = e.clipboardData?.items;
      if (!items) return;
      const imageFiles: File[] = [];
      for (const item of items) {
        if (ALLOWED_TYPES.includes(item.type)) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault();
        handleImageFiles(imageFiles);
      }
    }

    function onDrop(e: DragEvent) {
      const files = e.dataTransfer?.files;
      if (!files) return;
      const imageFiles: File[] = [];
      for (const file of files) {
        if (ALLOWED_TYPES.includes(file.type)) {
          imageFiles.push(file);
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault();
        handleImageFiles(imageFiles);
      }
    }

    function onDragOver(e: DragEvent) {
      e.preventDefault();
    }

    el.addEventListener("paste", onPaste);
    el.addEventListener("drop", onDrop);
    el.addEventListener("dragover", onDragOver);
    return () => {
      el.removeEventListener("paste", onPaste);
      el.removeEventListener("drop", onDrop);
      el.removeEventListener("dragover", onDragOver);
    };
  }, [folder]);

  return (
    <>
      <div ref={containerRef} className="absolute inset-0" />
      <EditorContextMenu containerRef={containerRef} />
    </>
  );
}
