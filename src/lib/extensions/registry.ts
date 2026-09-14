// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * registry.ts — the runtime catalog of markdown extensions.
 *
 * Extensions self-register here at import time (see `./index`), keyed by id. This
 * module answers "which extensions exist / are enabled / belong to a category"
 * for the toolbar, settings UI, and preview pipeline, and owns **lazy loading**:
 * an extension's heavy library (KaTeX, mermaid, abcjs, …) is only imported on
 * first use via {@link ensureLoaded}, which also resolves `dependsOn` first and
 * dedupes concurrent load requests so a library is fetched at most once.
 */
import type { MarkdownExtension, ExtensionId, ExtensionCategory } from "./types";

/** Central registry of all markdown extensions. */
const registry = new Map<ExtensionId, MarkdownExtension>();

/** Track which extensions have been lazy-loaded. */
const loaded = new Set<ExtensionId>();

/** Track in-flight loading promises to avoid double-loading. */
const loading = new Map<ExtensionId, Promise<void>>();

/** Register an extension. Called once per extension at import time. */
export function registerExtension(ext: MarkdownExtension): void {
  registry.set(ext.id, ext);
}

/** Get an extension by ID. */
export function getExtension(id: ExtensionId): MarkdownExtension | undefined {
  return registry.get(id);
}

/** Get all registered extensions. */
export function getAllExtensions(): MarkdownExtension[] {
  return Array.from(registry.values());
}

/** Get extensions grouped by category, in display order. */
export function getExtensionsByCategory(): {
  category: ExtensionCategory;
  label: string;
  extensions: MarkdownExtension[];
}[] {
  const order: { category: ExtensionCategory; label: string }[] = [
    { category: "core", label: "Core" },
    { category: "science", label: "Science" },
    { category: "diagrams", label: "Diagrams & Visuals" },
    { category: "media", label: "Media" },
    { category: "planning", label: "Planning" },
    { category: "document", label: "Document" },
  ];

  return order.map(({ category, label }) => ({
    category,
    label,
    extensions: getAllExtensions()
      .filter((e) => e.category === category)
      .sort((a, b) => a.toolbarOrder - b.toolbarOrder),
  }));
}

/** Get only the enabled extensions, filtered by the provided map. */
export function getEnabledExtensions(
  enabledMap: Partial<Record<ExtensionId, boolean>>,
): MarkdownExtension[] {
  return getAllExtensions().filter((ext) => enabledMap[ext.id] === true);
}

/** Lazy-load an extension's library if it hasn't been loaded yet. */
export async function ensureLoaded(id: ExtensionId): Promise<void> {
  if (loaded.has(id)) return;
  // Deduplicate: if already loading, wait for the in-flight promise
  if (loading.has(id)) return loading.get(id);

  const ext = registry.get(id);
  if (!ext) return;

  const promise = (async () => {
    // Load dependencies first (e.g., chemical depends on math/KaTeX)
    if (ext.dependsOn) {
      for (const dep of ext.dependsOn) {
        await ensureLoaded(dep);
      }
    }
    if (ext.load) {
      await ext.load();
    }
    loaded.add(id);
    loading.delete(id);
  })();

  loading.set(id, promise);
  return promise;
}

/** Lazy-load all enabled extensions. */
export async function ensureAllLoaded(
  enabledMap: Partial<Record<ExtensionId, boolean>>,
): Promise<void> {
  const promises = getEnabledExtensions(enabledMap)
    .filter((ext) => ext.load && !loaded.has(ext.id))
    .map((ext) => ensureLoaded(ext.id));
  await Promise.all(promises);
}
