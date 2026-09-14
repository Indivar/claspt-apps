// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Extension store — which markdown preview extensions are enabled.
 *
 * Claspt's markdown preview supports optional renderers (mermaid, charts, math,
 * kanban, etc.; see `@/lib/extensions`). This store holds the user's per-vault
 * on/off choices as `enabledMap` and derives the concrete `enabledExtensions`
 * list the preview pipeline and toolbar consume. State is seeded from
 * {@link VaultConfig.markdown_extensions} on unlock via {@link initFromConfig};
 * toggles return the new map so the caller can persist it back to config.
 *
 * {@link mergeWithDefaults} ensures extensions added in newer app versions pick
 * up their default when the stored config predates them.
 */
import { create } from "zustand";
import type { ExtensionId, ExtensionEnabledMap } from "@/lib/extensions/types";
import { DEFAULT_ENABLED, ALL_EXTENSION_IDS } from "@/lib/extensions/types";
import { getEnabledExtensions } from "@/lib/extensions/registry";
import type { MarkdownExtension } from "@/lib/extensions/types";
import type { VaultConfig } from "@claspt/shared/types";
import { createLogger } from "@/lib/logger";

const extLog = createLogger("extensions");

interface ExtensionStore {
  /** Map of extension ID → enabled state. */
  enabledMap: ExtensionEnabledMap;
  /** Derived: list of currently enabled extensions (for toolbar, preview). */
  enabledExtensions: MarkdownExtension[];
  /** Whether the map has been initialized from config. */
  initialized: boolean;

  /** Initialize from VaultConfig (called on vault unlock). */
  initFromConfig: (config: VaultConfig) => void;
  /** Toggle a single extension on/off. Returns the new map for saving. */
  toggle: (id: ExtensionId) => ExtensionEnabledMap;
  /** Set all extensions to the given state. Returns the new map for saving. */
  setAll: (enabled: boolean) => ExtensionEnabledMap;
  /** Check if an extension is enabled. */
  isEnabled: (id: ExtensionId) => boolean;
}

/** Build the default enabled map. */
function buildDefaultMap(): ExtensionEnabledMap {
  const map: ExtensionEnabledMap = {};
  for (const id of ALL_EXTENSION_IDS) {
    map[id] = DEFAULT_ENABLED.includes(id);
  }
  return map;
}

/** Merge config map with defaults (new extensions get their default). */
function mergeWithDefaults(
  configMap: ExtensionEnabledMap | undefined,
): ExtensionEnabledMap {
  const defaults = buildDefaultMap();
  if (!configMap) return defaults;
  // Keep config values, fill in missing with defaults
  const merged: ExtensionEnabledMap = { ...defaults };
  for (const id of ALL_EXTENSION_IDS) {
    if (id in configMap) {
      merged[id] = configMap[id];
    }
  }
  return merged;
}

/** Zustand hook exposing enabled-extension state and toggles. */
export const useExtensionStore = create<ExtensionStore>((set, get) => ({
  enabledMap: buildDefaultMap(),
  enabledExtensions: [],
  initialized: false,

  initFromConfig: (config) => {
    extLog.debug("initFromConfig — raw markdown_extensions:", config.markdown_extensions);
    const map = mergeWithDefaults(config.markdown_extensions);
    extLog.debug("initFromConfig — merged map:", map);
    set({
      enabledMap: map,
      enabledExtensions: getEnabledExtensions(map),
      initialized: true,
    });
  },

  toggle: (id) => {
    const current = get().enabledMap;
    const newMap = { ...current, [id]: !current[id] };
    set({
      enabledMap: newMap,
      enabledExtensions: getEnabledExtensions(newMap),
    });
    return newMap;
  },

  setAll: (enabled) => {
    const newMap: ExtensionEnabledMap = {};
    for (const id of ALL_EXTENSION_IDS) {
      newMap[id] = enabled;
    }
    set({
      enabledMap: newMap,
      enabledExtensions: getEnabledExtensions(newMap),
    });
    return newMap;
  },

  isEnabled: (id) => get().enabledMap[id] === true,
}));
