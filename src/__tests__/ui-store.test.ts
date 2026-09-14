// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { useUIStore, isDarkTheme, THEMES } from "@/stores/ui-store";

// Mock localStorage
const storage: Record<string, string> = {};
vi.stubGlobal("localStorage", {
  getItem: (key: string) => storage[key] ?? null,
  setItem: (key: string, val: string) => {
    storage[key] = val;
  },
  removeItem: (key: string) => {
    delete storage[key];
  },
});

describe("isDarkTheme", () => {
  it("returns true for dark-base themes", () => {
    expect(isDarkTheme("dark")).toBe(true);
    expect(isDarkTheme("nord")).toBe(true);
    expect(isDarkTheme("dracula")).toBe(true);
    expect(isDarkTheme("tokyo-night")).toBe(true);
  });

  it("returns false for light-base themes", () => {
    expect(isDarkTheme("light")).toBe(false);
    expect(isDarkTheme("solarized-light")).toBe(false);
    expect(isDarkTheme("github-light")).toBe(false);
  });
});

describe("THEMES", () => {
  it("has 20 themes", () => {
    expect(THEMES).toHaveLength(20);
  });

  it("each theme has required fields", () => {
    for (const t of THEMES) {
      expect(t.name).toBeTypeOf("string");
      expect(t.label).toBeTypeOf("string");
      expect(["light", "dark"]).toContain(t.base);
      expect(t.preview).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe("useUIStore", () => {
  beforeEach(() => {
    // Reset store between tests
    useUIStore.setState({
      sidebarOpen: true,
      theme: "dark",
      sidebarView: "list",
      settingsOpen: false,
      templatePickerOpen: false,
      inspectorOpen: false,
      importModalOpen: false,
      tagFilter: null,
      editorMode: "edit",
      helpOpen: false,
      aboutOpen: false,
      shareModalOpen: false,
      shareSecretLabel: null,
      collapsedFolders: {},
      renamingFolder: null,
      creatingFolder: false,
      tourActive: false,
      tourStep: 0,
      tourTier: "quick",
    });
  });

  it("toggleSidebar flips sidebarOpen", () => {
    expect(useUIStore.getState().sidebarOpen).toBe(true);
    useUIStore.getState().toggleSidebar();
    expect(useUIStore.getState().sidebarOpen).toBe(false);
    useUIStore.getState().toggleSidebar();
    expect(useUIStore.getState().sidebarOpen).toBe(true);
  });

  it("setSidebarOpen sets exact value", () => {
    useUIStore.getState().setSidebarOpen(false);
    expect(useUIStore.getState().sidebarOpen).toBe(false);
  });

  it("setTheme persists to localStorage", () => {
    useUIStore.getState().setTheme("nord");
    expect(useUIStore.getState().theme).toBe("nord");
    expect(storage["claspt-theme"]).toBe("nord");
  });

  it("cycleTheme moves to next theme", () => {
    useUIStore.getState().setTheme("light");
    useUIStore.getState().cycleTheme();
    expect(useUIStore.getState().theme).toBe("dark"); // light→dark
  });

  it("cycleTheme wraps around from last to first", () => {
    const last = THEMES[THEMES.length - 1]!.name;
    useUIStore.getState().setTheme(last);
    useUIStore.getState().cycleTheme();
    expect(useUIStore.getState().theme).toBe("light"); // wraps to first
  });

  it("toggleSettings flips settingsOpen", () => {
    expect(useUIStore.getState().settingsOpen).toBe(false);
    useUIStore.getState().toggleSettings();
    expect(useUIStore.getState().settingsOpen).toBe(true);
  });

  it("toggleInspector flips inspectorOpen", () => {
    useUIStore.getState().toggleInspector();
    expect(useUIStore.getState().inspectorOpen).toBe(true);
    useUIStore.getState().toggleInspector();
    expect(useUIStore.getState().inspectorOpen).toBe(false);
  });

  it("toggleTemplatePicker flips templatePickerOpen", () => {
    useUIStore.getState().toggleTemplatePicker();
    expect(useUIStore.getState().templatePickerOpen).toBe(true);
  });

  it("toggleImportModal flips importModalOpen", () => {
    useUIStore.getState().toggleImportModal();
    expect(useUIStore.getState().importModalOpen).toBe(true);
  });

  it("setTagFilter sets and clears tag", () => {
    useUIStore.getState().setTagFilter("work");
    expect(useUIStore.getState().tagFilter).toBe("work");
    useUIStore.getState().setTagFilter(null);
    expect(useUIStore.getState().tagFilter).toBeNull();
  });

  it("setEditorMode changes mode", () => {
    useUIStore.getState().setEditorMode("preview");
    expect(useUIStore.getState().editorMode).toBe("preview");
  });

  it("cycleSplitView toggles between edit and split", () => {
    expect(useUIStore.getState().editorMode).toBe("edit");
    useUIStore.getState().cycleSplitView();
    expect(useUIStore.getState().editorMode).toBe("split");
    useUIStore.getState().cycleSplitView();
    expect(useUIStore.getState().editorMode).toBe("edit");
  });

  it("cyclePreview toggles between edit and preview", () => {
    useUIStore.getState().cyclePreview();
    expect(useUIStore.getState().editorMode).toBe("preview");
    useUIStore.getState().cyclePreview();
    expect(useUIStore.getState().editorMode).toBe("edit");
  });

  it("toggleHelp flips helpOpen", () => {
    useUIStore.getState().toggleHelp();
    expect(useUIStore.getState().helpOpen).toBe(true);
  });

  it("setShareModalOpen sets modal and secret label", () => {
    useUIStore.getState().setShareModalOpen(true, "API Key");
    expect(useUIStore.getState().shareModalOpen).toBe(true);
    expect(useUIStore.getState().shareSecretLabel).toBe("API Key");
  });

  it("toggleShareModal clears secret label", () => {
    useUIStore.getState().setShareModalOpen(true, "API Key");
    useUIStore.getState().toggleShareModal();
    expect(useUIStore.getState().shareModalOpen).toBe(false);
    expect(useUIStore.getState().shareSecretLabel).toBeNull();
  });

  it("toggleFolderCollapsed tracks per-folder state", () => {
    useUIStore.getState().toggleFolderCollapsed("work");
    expect(useUIStore.getState().collapsedFolders["work"]).toBe(true);
    useUIStore.getState().toggleFolderCollapsed("work");
    expect(useUIStore.getState().collapsedFolders["work"]).toBe(false);
  });

  it("setRenamingFolder and setCreatingFolder work", () => {
    useUIStore.getState().setRenamingFolder("archive");
    expect(useUIStore.getState().renamingFolder).toBe("archive");
    useUIStore.getState().setCreatingFolder(true);
    expect(useUIStore.getState().creatingFolder).toBe(true);
  });

  it("setSidebarView changes view mode", () => {
    useUIStore.getState().setSidebarView("folders");
    expect(useUIStore.getState().sidebarView).toBe("folders");
  });
});
