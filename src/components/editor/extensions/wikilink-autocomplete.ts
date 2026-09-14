// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * CM6 CompletionSource: triggered by `[[` to suggest page titles for wiki-links.
 */
import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";

/**
 * Wikilink autocomplete source. Completes `[[` with page titles from the store.
 */
export function wikilinkCompletionSource(
  context: CompletionContext,
): CompletionResult | null {
  // Match `[[` followed by optional partial text
  const match = context.matchBefore(/\[\[[^\]|]*/);
  if (!match) return null;

  // Extract the partial text after [[
  const partial = match.text.slice(2).toLowerCase();

  // Lazy-load pages store to avoid circular deps
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pagesStore = require("@/stores/pages-store") as {
    usePagesStore: { getState: () => { pages: { meta: { title: string } }[] } };
  };
  const pages = pagesStore.usePagesStore.getState().pages;

  const options = pages
    .map((p) => p.meta.title)
    .filter((title) => title.toLowerCase().includes(partial))
    .slice(0, 20)
    .map((title) => ({
      label: title,
      apply: `[[${title}]]`,
      type: "text" as const,
    }));

  return {
    from: match.from,
    options,
    filter: false, // we already filtered
  };
}
