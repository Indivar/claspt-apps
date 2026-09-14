// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * UI store — all transient, presentation-only view state for the desktop shell.
 *
 * This is the catch-all for "what is currently shown": sidebar open/width/density,
 * the active {@link ThemeName}, editor mode (edit/preview/split), and the open/
 * closed state of every panel, modal, and picker (settings, inspector, import,
 * share, generator, help, about). Also drives the onboarding tour and sidebar
 * folder collapse state.
 *
 * A few slices persist to `localStorage` (theme, sidebar width, density) so they
 * survive restarts; everything else is session-only. Nothing here touches the
 * vault or the backend — it is pure frontend chrome. The exported helpers
 * ({@link applyThemeClasses}, {@link applyUIScale}, {@link isDarkTheme}) apply
 * state to the DOM and are reused by the vault store on config load.
 */
import { create } from "zustand";

/** All available themes. */
export type ThemeName =
  | "light"
  | "dark"
  | "nord"
  | "dracula"
  | "solarized-light"
  | "solarized-dark"
  | "monokai"
  | "gruvbox-dark"
  | "gruvbox-light"
  | "catppuccin-mocha"
  | "catppuccin-latte"
  | "rose-pine"
  | "tokyo-night"
  | "one-dark"
  | "github-light"
  | "github-dark"
  | "everforest-dark"
  | "kanagawa"
  | "ayu-light"
  | "midnight-blue";

/** Theme metadata for pickers. */
export interface ThemeMeta {
  name: ThemeName;
  label: string;
  base: "light" | "dark";
  preview: string; // primary surface color for swatch
}

export const THEMES: ThemeMeta[] = [
  { name: "light", label: "Light", base: "light", preview: "#ffffff" },
  { name: "dark", label: "Dark", base: "dark", preview: "#1a1a26" },
  { name: "nord", label: "Nord", base: "dark", preview: "#2e3440" },
  { name: "dracula", label: "Dracula", base: "dark", preview: "#282a36" },
  {
    name: "solarized-light",
    label: "Solarized Light",
    base: "light",
    preview: "#fdf6e3",
  },
  { name: "solarized-dark", label: "Solarized Dark", base: "dark", preview: "#002b36" },
  { name: "monokai", label: "Monokai", base: "dark", preview: "#272822" },
  { name: "gruvbox-dark", label: "Gruvbox Dark", base: "dark", preview: "#282828" },
  { name: "gruvbox-light", label: "Gruvbox Light", base: "light", preview: "#fbf1c7" },
  {
    name: "catppuccin-mocha",
    label: "Catppuccin Mocha",
    base: "dark",
    preview: "#1e1e2e",
  },
  {
    name: "catppuccin-latte",
    label: "Catppuccin Latte",
    base: "light",
    preview: "#eff1f5",
  },
  { name: "rose-pine", label: "Rose Pine", base: "dark", preview: "#191724" },
  { name: "tokyo-night", label: "Tokyo Night", base: "dark", preview: "#1a1b26" },
  { name: "one-dark", label: "One Dark", base: "dark", preview: "#282c34" },
  { name: "github-light", label: "GitHub Light", base: "light", preview: "#ffffff" },
  { name: "github-dark", label: "GitHub Dark", base: "dark", preview: "#0d1117" },
  { name: "everforest-dark", label: "Everforest", base: "dark", preview: "#2d353b" },
  { name: "kanagawa", label: "Kanagawa", base: "dark", preview: "#1f1f28" },
  { name: "ayu-light", label: "Ayu Light", base: "light", preview: "#fcfcfc" },
  { name: "midnight-blue", label: "Midnight Blue", base: "dark", preview: "#0f172a" },
];

/** Check if a theme name is a dark-base theme. */
export function isDarkTheme(theme: ThemeName): boolean {
  return THEMES.find((t) => t.name === theme)?.base === "dark";
}

interface UIStore {
  /** Whether the sidebar is visible. */
  sidebarOpen: boolean;
  /** Current theme. */
  theme: ThemeName;
  /** Whether the sidebar shows folder tree or flat list. */
  sidebarView: "list" | "folders";
  /** Whether the settings panel is visible. */
  settingsOpen: boolean;
  /** Which settings section to open (consumed once by SettingsPanel). */
  settingsSection: string | null;
  /** Whether the secret template picker is visible. */
  templatePickerOpen: boolean;
  /** Whether the inspector panel is visible. */
  inspectorOpen: boolean;
  /** Whether the import modal is visible. */
  importModalOpen: boolean;
  /** Active tag filter for sidebar page list. */
  tagFilter: string | null;
  /** Editor view mode. */
  editorMode: "edit" | "preview" | "split";
  /** Whether the markdown help modal is visible. */
  helpOpen: boolean;
  /** Whether the about dialog is visible. */
  aboutOpen: boolean;
  /** Whether the share modal is visible. */
  shareModalOpen: boolean;
  /** Pre-selected secret label for sharing (null = share entire page). */
  shareSecretLabel: string | null;
  /** Which folders are collapsed in sidebar. */
  collapsedFolders: Record<string, boolean>;
  /** Folder currently being renamed (null = none). */
  renamingFolder: string | null;
  /** Whether the inline folder-create field is visible. */
  creatingFolder: boolean;
  /** Sidebar width in pixels. */
  sidebarWidth: number;
  /** Sidebar page list density. */
  sidebarDensity: "compact" | "detailed";
  /** Whether the generator modal is visible. */
  generatorOpen: boolean;
  /** Callback to auto-fill a secret field value when generator is opened inline. */
  generatorFieldCallback: ((value: string) => void) | null;

  // Tour
  tourActive: boolean;
  tourStep: number;
  tourTier: "quick" | "advanced";
  startTour: (tier: "quick" | "advanced") => void;
  setTourActive: (active: boolean) => void;
  nextTourStep: () => void;
  prevTourStep: () => void;

  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  setTheme: (theme: ThemeName) => void;
  cycleTheme: () => void;
  setSidebarView: (view: "list" | "folders") => void;
  setSettingsOpen: (open: boolean) => void;
  setSettingsSection: (section: string | null) => void;
  toggleSettings: () => void;
  setTemplatePickerOpen: (open: boolean) => void;
  toggleTemplatePicker: () => void;
  setInspectorOpen: (open: boolean) => void;
  toggleInspector: () => void;
  setImportModalOpen: (open: boolean) => void;
  toggleImportModal: () => void;
  setTagFilter: (tag: string | null) => void;
  setEditorMode: (mode: "edit" | "preview" | "split") => void;
  /** Cycle edit → split → edit. */
  cycleSplitView: () => void;
  /** Cycle edit → preview → edit. */
  cyclePreview: () => void;
  setHelpOpen: (open: boolean) => void;
  toggleHelp: () => void;
  setAboutOpen: (open: boolean) => void;
  setShareModalOpen: (open: boolean, secretLabel?: string | null) => void;
  toggleShareModal: () => void;
  toggleFolderCollapsed: (name: string) => void;
  collapseAllFolders: (folders: string[]) => void;
  expandAllFolders: () => void;
  setRenamingFolder: (name: string | null) => void;
  setCreatingFolder: (creating: boolean) => void;
  setSidebarWidth: (width: number) => void;
  toggleSidebarDensity: () => void;
  setGeneratorOpen: (open: boolean, onSelect?: (value: string) => void) => void;
  toggleGenerator: () => void;
}

function loadPersistedTheme(): ThemeName {
  const stored = localStorage.getItem("claspt-theme");
  if (stored && THEMES.some((t) => t.name === stored)) return stored as ThemeName;
  return "dark";
}

function persistTheme(theme: ThemeName) {
  localStorage.setItem("claspt-theme", theme);
}

function loadPersistedSidebarWidth(): number {
  const stored = localStorage.getItem("claspt-sidebar-width");
  if (stored) {
    const n = Number(stored);
    if (n >= 180 && n <= 480) return n;
  }
  return 280;
}

function persistSidebarWidth(width: number) {
  localStorage.setItem("claspt-sidebar-width", String(width));
}

/** Apply UI scale to the root element via CSS variable. */
export function applyUIScale(scale: number) {
  document.documentElement.style.setProperty("--ui-scale", String(scale));
}

/** Apply theme classes to <html>. Adds the theme-specific class + .dark when needed. */
export function applyThemeClasses(theme: ThemeName) {
  const el = document.documentElement;
  // Remove all theme classes
  THEMES.forEach((t) => {
    if (t.name !== "light" && t.name !== "dark") {
      el.classList.remove(`theme-${t.name}`);
    }
  });
  // Toggle .dark based on theme base
  el.classList.toggle("dark", isDarkTheme(theme));
  // Add theme-specific class (light and dark use base CSS, no extra class needed)
  if (theme !== "light" && theme !== "dark") {
    el.classList.add(`theme-${theme}`);
  }
}

/** Zustand hook exposing view/chrome state and its toggles. */
export const useUIStore = create<UIStore>((set, get) => ({
  sidebarOpen: true,
  theme: loadPersistedTheme(),
  sidebarView: "list",
  settingsOpen: false,
  settingsSection: null,
  templatePickerOpen: false,
  inspectorOpen: false,
  importModalOpen: false,
  tagFilter: null,
  editorMode: "edit" as const,
  helpOpen: false,
  aboutOpen: false,
  shareModalOpen: false,
  shareSecretLabel: null,
  collapsedFolders: {},
  renamingFolder: null,
  creatingFolder: false,
  sidebarWidth: loadPersistedSidebarWidth(),
  sidebarDensity: (localStorage.getItem("claspt-sidebar-density") === "compact"
    ? "compact"
    : "detailed") as "compact" | "detailed",
  generatorOpen: false,
  generatorFieldCallback: null,
  tourActive: false,
  tourStep: 0,
  tourTier: "quick" as const,

  toggleSidebar: () => set({ sidebarOpen: !get().sidebarOpen }),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  setTheme: (theme) => {
    persistTheme(theme);
    applyThemeClasses(theme);
    set({ theme });
  },
  cycleTheme: () => {
    const current = get().theme;
    const idx = THEMES.findIndex((t) => t.name === current);
    const next = THEMES[(idx + 1) % THEMES.length]!.name;
    persistTheme(next);
    applyThemeClasses(next);
    set({ theme: next });
  },
  setSidebarView: (view) => set({ sidebarView: view }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setSettingsSection: (section) => set({ settingsSection: section }),
  toggleSettings: () => set({ settingsOpen: !get().settingsOpen }),
  setTemplatePickerOpen: (open) => set({ templatePickerOpen: open }),
  toggleTemplatePicker: () => set({ templatePickerOpen: !get().templatePickerOpen }),
  setInspectorOpen: (open) => set({ inspectorOpen: open }),
  toggleInspector: () => set({ inspectorOpen: !get().inspectorOpen }),
  setImportModalOpen: (open) => set({ importModalOpen: open }),
  toggleImportModal: () => set({ importModalOpen: !get().importModalOpen }),
  setTagFilter: (tag) => set({ tagFilter: tag }),
  setEditorMode: (mode) => set({ editorMode: mode }),
  cycleSplitView: () =>
    set({ editorMode: get().editorMode === "split" ? "edit" : "split" }),
  cyclePreview: () =>
    set({ editorMode: get().editorMode === "preview" ? "edit" : "preview" }),
  setHelpOpen: (open) => set({ helpOpen: open }),
  toggleHelp: () => set({ helpOpen: !get().helpOpen }),
  setAboutOpen: (open) => set({ aboutOpen: open }),
  setShareModalOpen: (open, secretLabel) =>
    set({ shareModalOpen: open, shareSecretLabel: secretLabel ?? null }),
  toggleShareModal: () =>
    set({ shareModalOpen: !get().shareModalOpen, shareSecretLabel: null }),
  toggleFolderCollapsed: (name) =>
    set((state) => ({
      collapsedFolders: {
        ...state.collapsedFolders,
        [name]: !state.collapsedFolders[name],
      },
    })),
  collapseAllFolders: (folders) =>
    set({ collapsedFolders: Object.fromEntries(folders.map((f) => [f, true])) }),
  expandAllFolders: () => set({ collapsedFolders: {} }),
  setRenamingFolder: (name) => set({ renamingFolder: name }),
  setCreatingFolder: (creating) => set({ creatingFolder: creating }),
  setSidebarWidth: (width) => {
    const clamped = Math.min(480, Math.max(180, width));
    persistSidebarWidth(clamped);
    set({ sidebarWidth: clamped });
  },
  toggleSidebarDensity: () => {
    const next = get().sidebarDensity === "compact" ? "detailed" : "compact";
    localStorage.setItem("claspt-sidebar-density", next);
    set({ sidebarDensity: next });
  },
  setGeneratorOpen: (open, onSelect) =>
    set({ generatorOpen: open, generatorFieldCallback: onSelect ?? null }),
  toggleGenerator: () =>
    set({ generatorOpen: !get().generatorOpen, generatorFieldCallback: null }),
  startTour: (tier) => set({ tourActive: true, tourStep: 0, tourTier: tier }),
  setTourActive: (active) => set({ tourActive: active }),
  nextTourStep: () => set((s) => ({ tourStep: s.tourStep + 1 })),
  prevTourStep: () => set((s) => ({ tourStep: Math.max(0, s.tourStep - 1) })),
}));
