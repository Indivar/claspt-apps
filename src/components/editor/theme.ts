// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

/**
 * Claspt editor theme — uses CSS custom properties so it
 * automatically adapts to dark/light mode.
 */
const clasptEditorTheme = EditorView.theme({
  "&": {
    fontSize: "var(--editor-font-size, 15px)",
    height: "100%",
    backgroundColor: "var(--color-surface)",
    color: "var(--color-text-primary)",
  },
  ".cm-content": {
    fontFamily:
      "var(--editor-font-family, 'JetBrains Mono', 'Fira Code', 'SF Mono', Consolas, 'Courier New', Monaco, monospace)",
    padding: "16px 0",
    caretColor: "var(--color-accent)",
    color: "var(--color-text-primary)",
    lineHeight: "1.7",
  },
  ".cm-line": {
    padding: "0 16px",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--color-accent)",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    {
      backgroundColor: "color-mix(in srgb, var(--color-accent) 20%, transparent)",
    },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in srgb, var(--color-text-muted) 5%, transparent)",
  },
  ".cm-scroller": {
    display: "flex",
    alignItems: "flex-start",
  },
  ".cm-gutters": {
    backgroundColor: "var(--color-surface)",
    borderRight: "1px solid var(--color-border)",
    color: "var(--color-text-muted)",
    flexShrink: "0",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "var(--color-text-secondary)",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    padding: "0 8px 0 16px",
    minWidth: "40px",
  },
  // Heading LINE decorations — applied to .cm-line via StateField so
  // CodeMirror can measure heights correctly and keep the gutter in sync.
  ".cm-heading-line-1": {
    fontSize: "1.875em",
    lineHeight: "1.3",
  },
  ".cm-heading-line-2": {
    fontSize: "1.5em",
    lineHeight: "1.35",
  },
  ".cm-heading-line-3": {
    fontSize: "1.25em",
    lineHeight: "1.4",
  },
  ".cm-heading-line-4": {
    fontSize: "1.125em",
    lineHeight: "1.45",
  },
  ".cm-heading-line-5": {
    fontSize: "1em",
  },
  ".cm-heading-line-6": {
    fontSize: "0.95em",
  },
  // Heading MARK styles — color/weight only (no fontSize, that's on the line).
  ".cm-heading-1": {
    fontWeight: "700",
    color: "var(--color-text-primary)",
  },
  ".cm-heading-2": {
    fontWeight: "700",
    color: "var(--color-text-primary)",
  },
  ".cm-heading-3": {
    fontWeight: "600",
    color: "var(--color-text-primary)",
  },
  ".cm-heading-4": {
    fontWeight: "600",
    color: "var(--color-text-primary)",
  },
  ".cm-heading-5": {
    fontWeight: "600",
    color: "var(--color-text-secondary)",
  },
  ".cm-heading-6": {
    fontWeight: "600",
    color: "var(--color-text-muted)",
  },
  // Secret block highlighting
  ".cm-secret-line": {
    backgroundColor: "var(--color-secret-bg)",
    borderLeft: "2px solid var(--color-secret)",
    paddingLeft: "4px",
  },
  ".cm-secret-value": {
    // Mask secret values with bullets — the actual values are visible
    // in the SecretCard panel below; the editor should never show them.
    // Using -webkit-text-security for Tauri's WebKit/Blink-based WebView.
    "-webkit-text-security": "disc",
    color: "var(--color-text-muted)",
    letterSpacing: "2px",
  },
  ".cm-secret-gutter": {
    color: "var(--color-secret)",
    fontSize: "12px",
  },
  // Math preview widget
  ".cm-math-preview": {
    display: "inline",
    verticalAlign: "baseline",
  },
  ".cm-math-preview .katex": {
    fontSize: "inherit",
  },
  // Horizontal rule
  ".cm-hr": {
    color: "var(--color-border)",
  },
  // Blockquote
  ".cm-blockquote": {
    borderLeft: "3px solid var(--color-accent)",
    paddingLeft: "12px",
    color: "var(--color-text-secondary)",
    fontStyle: "italic",
  },
});

/**
 * Syntax highlighting for markdown tokens — adapts to dark/light
 * via CSS variables.
 */
const clasptHighlightStyle = HighlightStyle.define([
  // Headings
  { tag: tags.heading1, class: "cm-heading-1" },
  { tag: tags.heading2, class: "cm-heading-2" },
  { tag: tags.heading3, class: "cm-heading-3" },
  { tag: tags.heading4, class: "cm-heading-4" },
  { tag: tags.heading5, class: "cm-heading-5" },
  { tag: tags.heading6, class: "cm-heading-6" },
  // Heading markers (# symbols)
  {
    tag: tags.processingInstruction,
    color: "var(--color-text-muted)",
    fontWeight: "400",
  },
  // Emphasis
  { tag: tags.emphasis, fontStyle: "italic", color: "var(--color-text-primary)" },
  { tag: tags.strong, fontWeight: "bold", color: "var(--color-text-primary)" },
  {
    tag: tags.strikethrough,
    textDecoration: "line-through",
    color: "var(--color-text-muted)",
  },
  // Code
  {
    tag: tags.monospace,
    fontFamily: "'JetBrains Mono', monospace",
    backgroundColor: "color-mix(in srgb, var(--color-text-muted) 15%, transparent)",
    borderRadius: "3px",
    padding: "1px 4px",
    fontSize: "0.9em",
  },
  // Links
  { tag: tags.link, color: "var(--color-accent)", textDecoration: "underline" },
  { tag: tags.url, color: "var(--color-accent)", textDecoration: "underline" },
  // List markers
  { tag: tags.list, color: "var(--color-accent)" },
  // Quote
  { tag: tags.quote, class: "cm-blockquote" },
  // Horizontal rule
  { tag: tags.contentSeparator, class: "cm-hr" },
  // Meta / frontmatter
  { tag: tags.meta, color: "var(--color-text-muted)" },
  // HTML tags in markdown
  { tag: tags.angleBracket, color: "var(--color-text-muted)" },
  { tag: tags.tagName, color: "var(--color-accent)" },
  { tag: tags.attributeName, color: "var(--color-text-secondary)" },
  { tag: tags.attributeValue, color: "var(--color-success)" },
  // Generic code highlighting (for fenced code blocks)
  { tag: tags.keyword, color: "#c084fc" },
  { tag: tags.definition(tags.variableName), color: "#60a5fa" },
  { tag: tags.variableName, color: "var(--color-text-primary)" },
  { tag: tags.function(tags.variableName), color: "#60a5fa" },
  { tag: tags.typeName, color: "#fbbf24" },
  { tag: tags.string, color: "#34d399" },
  { tag: tags.number, color: "#fb923c" },
  { tag: tags.bool, color: "#fb923c" },
  { tag: tags.null, color: "#fb923c" },
  { tag: tags.operator, color: "var(--color-text-secondary)" },
  { tag: tags.comment, color: "var(--color-text-muted)", fontStyle: "italic" },
  { tag: tags.punctuation, color: "var(--color-text-muted)" },
]);

/** Combined theme + highlight style for the Claspt editor. */
export const clasptTheme = [clasptEditorTheme, syntaxHighlighting(clasptHighlightStyle)];
