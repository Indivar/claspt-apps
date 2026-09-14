// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { useEffect } from "react";
import { useSearchStore } from "@/stores/search-store";
import { useUIStore } from "@/stores/ui-store";
import { useVaultStore } from "@/stores/vault-store";

/**
 * Global keyboard shortcuts.
 *
 * - Cmd/Ctrl+K: Toggle search
 * - Cmd/Ctrl+B: Toggle sidebar
 * - Cmd/Ctrl+,: Toggle settings
 * - Cmd/Ctrl+Shift+L: Lock vault
 * - Cmd/Ctrl+Shift+S: Insert secret block template
 * - Cmd/Ctrl+I: Toggle inspector panel
 * - Cmd/Ctrl+S: Force save now
 * - Cmd/Ctrl+E: Toggle edit ↔ preview
 * - Cmd/Ctrl+\: Toggle split view (edit ↔ split)
 * - Cmd/Ctrl+/: Toggle preview (edit ↔ preview)
 * - Cmd/Ctrl+Shift+/: Toggle markdown help
 * - Cmd/Ctrl+Shift+E: Toggle share modal
 * - Cmd/Ctrl+G: Toggle generator
 */
export function useKeyboard() {
  const toggleSearch = useSearchStore((s) => s.toggle);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const toggleSettings = useUIStore((s) => s.toggleSettings);
  const toggleTemplatePicker = useUIStore((s) => s.toggleTemplatePicker);
  const toggleInspector = useUIStore((s) => s.toggleInspector);
  const toggleHelp = useUIStore((s) => s.toggleHelp);
  const cycleSplitView = useUIStore((s) => s.cycleSplitView);
  const cyclePreview = useUIStore((s) => s.cyclePreview);
  const toggleShareModal = useUIStore((s) => s.toggleShareModal);
  const toggleGenerator = useUIStore((s) => s.toggleGenerator);
  const lock = useVaultStore((s) => s.lock);

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;

      if (mod && e.key === "k") {
        e.preventDefault();
        toggleSearch();
      }

      if (mod && e.key === "b") {
        e.preventDefault();
        toggleSidebar();
      }

      if (mod && e.key === ",") {
        e.preventDefault();
        toggleSettings();
      }

      if (mod && e.shiftKey && e.key === "L") {
        e.preventDefault();
        lock();
      }

      if (mod && e.shiftKey && e.key === "S") {
        e.preventDefault();
        toggleTemplatePicker();
      }

      if (mod && e.shiftKey && e.key === "E") {
        e.preventDefault();
        toggleShareModal();
      }

      if (mod && e.key === "i") {
        e.preventDefault();
        toggleInspector();
      }

      if (mod && e.key === "\\") {
        e.preventDefault();
        cycleSplitView();
      }

      if (mod && e.key === "/") {
        e.preventDefault();
        if (e.shiftKey) {
          toggleHelp();
        } else {
          cyclePreview();
        }
      }

      if (mod && e.key === "g") {
        e.preventDefault();
        toggleGenerator();
      }

      // Mod+S: Force save now
      if (mod && e.key === "s") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("claspt:force-save"));
      }

      // Mod+E: Toggle edit ↔ preview
      if (mod && e.key === "e" && !e.shiftKey) {
        e.preventDefault();
        cyclePreview();
      }
    }

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    toggleSearch,
    toggleSidebar,
    toggleSettings,
    toggleTemplatePicker,
    toggleInspector,
    toggleHelp,
    cycleSplitView,
    cyclePreview,
    toggleShareModal,
    toggleGenerator,
    lock,
  ]);
}
