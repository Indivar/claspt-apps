// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * preview-pipeline.ts — turns raw markdown into sanitized preview HTML.
 *
 * This is the heart of the markdown preview. The full pipeline is:
 *   maskSecretBlocks → runPreprocessors → Marked.parse → DOMPurify.sanitize
 * followed (after the HTML is in the DOM) by {@link runPostProcessors} for
 * extensions that render into placeholders (mermaid, charts, music, …).
 *
 * Security-sensitive by design — treat changes here carefully:
 *  - **{@link maskSecretBlocks}** replaces `:::secret[...]` bodies with a redacted
 *    quote *before* parsing, so decrypted/plaintext secret values never reach the
 *    rendered HTML (and never leak into copyable preview text).
 *  - **DOMPurify** sanitizes all generated HTML. Extensions may widen the
 *    allowlist only through their declared `purifyTags`/`purifyAttrs`
 *    ({@link createPurifyConfig}); nothing else is trusted.
 *  - The {@link encodeSource}/{@link decodeSource} helpers URI-encode multi-line
 *    source stashed in `data-*` attributes so it survives HTML attribute
 *    normalization and DOMPurify intact.
 *
 * {@link createMarkedInstance} wires syntax highlighting (a curated subset of
 * highlight.js languages) and every enabled extension's Marked hooks, taking care
 * to skip highlighting for fenced languages an extension owns (it needs raw source).
 */
import { Marked } from "marked";
import { markedHighlight } from "marked-highlight";
import hljs from "highlight.js/lib/core";
import DOMPurify from "dompurify";
import type { ExtensionEnabledMap } from "./types";
import { getEnabledExtensions, ensureAllLoaded } from "./registry";

// Register common languages for code block highlighting.
// Using individual imports to keep bundle size reasonable (~40KB vs ~300KB for all).
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import graphql from "highlight.js/lib/languages/graphql";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import markdown from "highlight.js/lib/languages/markdown";
import nginx from "highlight.js/lib/languages/nginx";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("css", css);
hljs.registerLanguage("dockerfile", dockerfile);
hljs.registerLanguage("go", go);
hljs.registerLanguage("graphql", graphql);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("java", java);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("js", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("kotlin", kotlin);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("nginx", nginx);
hljs.registerLanguage("python", python);
hljs.registerLanguage("py", python);
hljs.registerLanguage("ruby", ruby);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("rs", rust);
hljs.registerLanguage("scss", scss);
hljs.registerLanguage("sh", bash);
hljs.registerLanguage("shell", shell);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("swift", swift);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("ts", typescript);
hljs.registerLanguage("tsx", typescript);
hljs.registerLanguage("jsx", javascript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("yml", yaml);

// Allow loading attribute through DOMPurify (carried over from original)
DOMPurify.addHook("uponSanitizeAttribute", (_node, data) => {
  if (data.attrName === "loading") {
    data.forceKeepAttr = true;
  }
});

/** Escape characters that have special meaning in markdown. */
function escapeMarkdown(s: string): string {
  return s.replace(/([[\]()\\<>*_~`#|!])/g, "\\$1");
}

/** HTML-encode a string for safe use in attributes and content. */
export function encodeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Decode an HTML-encoded attribute value. */
export function decodeAttr(s: string): string {
  return s
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

/** URI-encode a string for data-*-source attributes that contain multi-line content.
 *  HTML5 attribute normalization converts newlines to spaces — URI encoding
 *  produces only safe ASCII (%0A, %3E, etc.) that survives DOMPurify intact. */
export function encodeSource(s: string): string {
  return encodeURIComponent(s);
}

/** Decode a URI-encoded source attribute. */
export function decodeSource(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Create a configured Marked instance with enabled extensions.
 * The instance includes all Marked-level hooks (tokenizers, renderers).
 */
export function createMarkedInstance(enabledMap: ExtensionEnabledMap): Marked {
  const md = new Marked({ gfm: true, breaks: true });

  const extensions = getEnabledExtensions(enabledMap);

  // Collect language identifiers claimed by extensions so the syntax
  // highlighter skips them — their renderers handle the raw source.
  const extensionLangs = new Set<string>();
  for (const ext of extensions) {
    if (ext.markedExtension) {
      // Known extension languages — add them to the skip list
      if (ext.id === "mermaid") extensionLangs.add("mermaid");
      if (ext.id === "charts") extensionLangs.add("chart");
      if (ext.id === "graphviz") {
        extensionLangs.add("dot");
        extensionLangs.add("graphviz");
      }
      if (ext.id === "timelines") extensionLangs.add("timeline");
      if (ext.id === "kanban") extensionLangs.add("kanban");
      if (ext.id === "spreadsheets") {
        extensionLangs.add("spreadsheet");
        extensionLangs.add("csv");
      }
      if (ext.id === "music") {
        extensionLangs.add("abc");
        extensionLangs.add("music");
      }
    }
  }

  // Syntax highlighting for fenced code blocks — skip extension-owned languages
  md.use(
    markedHighlight({
      langPrefix: "hljs language-",
      highlight(code, lang) {
        // Don't highlight code blocks owned by extensions — they need raw source
        if (lang && extensionLangs.has(lang)) return code;
        if (lang && hljs.getLanguage(lang)) {
          return hljs.highlight(code, { language: lang }).value;
        }
        // Auto-detect for unlabelled code blocks
        return hljs.highlightAuto(code).value;
      },
    }),
  );

  for (const ext of extensions) {
    if (ext.markedExtension) {
      const markedExt = ext.markedExtension();
      if (Array.isArray(markedExt)) {
        for (const e of markedExt) md.use(e);
      } else {
        md.use(markedExt);
      }
    }
  }

  return md;
}

/** DOMPurify sanitize options we use. */
export interface PurifyOptions {
  ADD_TAGS: string[];
  ADD_ATTR: string[];
  ALLOW_DATA_ATTR: boolean;
}

/**
 * Build DOMPurify config with extra tags/attrs from enabled extensions.
 */
export function createPurifyConfig(enabledMap: ExtensionEnabledMap): PurifyOptions {
  const config: PurifyOptions = {
    ADD_ATTR: ["loading"],
    ADD_TAGS: [],
    ALLOW_DATA_ATTR: true,
  };

  const extensions = getEnabledExtensions(enabledMap);
  for (const ext of extensions) {
    if (ext.purifyTags) config.ADD_TAGS.push(...ext.purifyTags);
    if (ext.purifyAttrs) config.ADD_ATTR.push(...ext.purifyAttrs);
  }

  return config;
}

/**
 * Mask secret blocks in content (existing behavior, extracted here).
 */
export function maskSecretBlocks(content: string): string {
  // Mask complete secret blocks (opening + closing fence).
  // Use ^ anchor so we only match :::secret at the start of a line —
  // this avoids matching inline code like `:::secret[Label]`.
  let masked = content.replace(
    /^:::secret\[((?:[^\]\\]|\\.)*)\][\s\S]*?^:::\s*$/gm,
    (_match, label: string) =>
      `> **[Secret: ${escapeMarkdown(label.replace(/\\\]/g, "]"))}]**`,
  );
  // Mask partial/unclosed secret blocks (at end of document)
  masked = masked.replace(
    /^:::secret\[((?:[^\]\\]|\\.)*)\][\s\S]*$/gm,
    (_match, label: string) =>
      `> **[Secret: ${escapeMarkdown(label.replace(/\\\]/g, "]"))}]** *(editing...)*`,
  );
  return masked;
}

/**
 * Run all enabled pre-processors on content (before Marked parsing).
 */
export function runPreprocessors(
  content: string,
  enabledMap: ExtensionEnabledMap,
): string {
  let result = content;
  const extensions = getEnabledExtensions(enabledMap);
  for (const ext of extensions) {
    if (ext.preprocess) {
      result = ext.preprocess(result);
    }
  }
  return result;
}

/**
 * Run all enabled post-processors on the rendered container.
 * Returns a cleanup function that disposes all post-processor resources.
 */
export function runPostProcessors(
  container: HTMLElement,
  enabledMap: ExtensionEnabledMap,
): () => void {
  const cleanups: (() => void)[] = [];
  const extensions = getEnabledExtensions(enabledMap);

  for (const ext of extensions) {
    if (ext.postprocess) {
      const cleanup = ext.postprocess(container);
      if (cleanup) cleanups.push(cleanup);
    }
  }

  return () => {
    for (const fn of cleanups) fn();
  };
}

/**
 * Full render pipeline: preprocess → parse → sanitize.
 * Does NOT handle post-processing (that runs after DOM insertion).
 */
export function renderMarkdown(
  content: string,
  markedInstance: Marked,
  purifyConfig: PurifyOptions,
  enabledMap: ExtensionEnabledMap,
): string {
  const masked = maskSecretBlocks(content);
  const preprocessed = runPreprocessors(masked, enabledMap);
  const raw = markedInstance.parse(preprocessed, { async: false }) as string;
  return DOMPurify.sanitize(raw, purifyConfig);
}

/** Ensure all enabled extension libraries are loaded. */
export { ensureAllLoaded };
