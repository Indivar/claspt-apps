// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * types.ts — the contract every markdown preview extension implements.
 *
 * Claspt's preview supports a fixed set of optional renderers (math, mermaid,
 * charts, kanban, …), each identified by an {@link ExtensionId}. An extension is
 * described by a {@link MarkdownExtension} record that plugs into the render
 * pipeline at several stages: a `preprocess` text transform, a `markedExtension`
 * (Marked tokenizer/renderer), DOMPurify allowlist additions, a `postprocess`
 * DOM hook (for libraries that render into placeholders), and a lazy `load`.
 * This file also declares the canonical id/default lists consumed by the
 * extension store and registry.
 */
import type { MarkedExtension } from "marked";

/** All known extension identifiers. */
export type ExtensionId =
  | "math"
  | "mermaid"
  | "callouts"
  | "wikilinks"
  | "footnotes"
  | "chemical"
  | "graphviz"
  | "charts"
  | "timelines"
  | "music"
  | "embeds"
  | "kanban"
  | "spreadsheets"
  | "toc"
  | "presentations";

/** Categories for grouping extensions in UI. */
export type ExtensionCategory =
  | "core"
  | "science"
  | "diagrams"
  | "media"
  | "planning"
  | "document";

/** Extension metadata and hooks into the preview pipeline. */
export interface MarkdownExtension {
  id: ExtensionId;
  name: string;
  description: string;
  category: ExtensionCategory;
  defaultEnabled: boolean;
  /** Text inserted when the toolbar button is clicked. */
  toolbarInsert?: string;
  /** Sort order within the toolbar row. */
  toolbarOrder: number;
  /** SVG path for the toolbar icon (16x16 viewBox). */
  iconPath?: string;
  /** Hook into the Marked parser (tokenizers, renderers). */
  markedExtension?: () => MarkedExtension | MarkedExtension[];
  /** Transform content before Marked parses it. */
  preprocess?: (content: string) => string;
  /** Run after sanitized HTML is inserted into the DOM. Return cleanup fn. */
  postprocess?: (container: HTMLElement) => void | (() => void);
  /** Fenced code block language identifiers claimed by this extension.
   *  The syntax highlighter will skip these so the extension renderer
   *  receives raw source text instead of highlighted HTML. */
  codeFenceLangs?: string[];
  /** Extra tags to allow through DOMPurify. */
  purifyTags?: string[];
  /** Extra attributes to allow through DOMPurify. */
  purifyAttrs?: string[];
  /** Lazy-load the extension's library (called once on first use). */
  load?: () => Promise<void>;
  /** Dependencies — other extensions that must also be enabled. */
  dependsOn?: ExtensionId[];
}

/** Map of extension ID to enabled state, stored in VaultConfig. */
export type ExtensionEnabledMap = Partial<Record<ExtensionId, boolean>>;

/** All 15 extension IDs for iteration. */
export const ALL_EXTENSION_IDS: ExtensionId[] = [
  "math",
  "mermaid",
  "callouts",
  "wikilinks",
  "footnotes",
  "chemical",
  "graphviz",
  "charts",
  "timelines",
  "music",
  "embeds",
  "kanban",
  "spreadsheets",
  "toc",
  "presentations",
];

/** Extensions enabled by default for new vaults. */
export const DEFAULT_ENABLED: ExtensionId[] = [
  "math",
  "mermaid",
  "callouts",
  "wikilinks",
  "footnotes",
  "chemical",
  "graphviz",
  "charts",
  "timelines",
  "music",
  "embeds",
  "kanban",
  "spreadsheets",
  "toc",
  "presentations",
];
