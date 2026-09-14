// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { useUIStore } from "@/stores/ui-store";
import { useSearchStore } from "@/stores/search-store";
import { usePagesStore } from "@/stores/pages-store";

export interface TourStep {
  id: string;
  tier: "quick" | "advanced";
  target: string;
  title: string;
  description: string;
  placement: "top" | "right" | "bottom" | "left";
  version: number;
  /** Optional action to prepare UI state before highlighting this step */
  prepare?: () => void;
  /** Optional cleanup when leaving this step (close panels, dialogs, etc.) */
  cleanup?: () => void;
}

export const CURRENT_TOUR_VERSION = 1;

export const TOUR_STEPS: TourStep[] = [
  // ── Quick Tour (6 steps) ──────────────────────────
  {
    id: "folders",
    tier: "quick",
    target: '[data-tour="folders"]',
    title: "Folders",
    description:
      "Organize your pages into folders. Click a folder to filter, or create new ones with the + button.",
    placement: "right",
    version: 1,
  },
  {
    id: "new-page",
    tier: "quick",
    target: '[data-tour="new-page"]',
    title: "Create a Page",
    description:
      "Start writing \u2014 click + to create your first page in the selected folder.",
    placement: "right",
    version: 1,
  },
  {
    id: "editor",
    tier: "quick",
    target: '[data-tour="editor"]',
    title: "The Editor",
    description:
      "Full markdown editor with split preview. Supports 50+ languages, tables, and 15 extensions.",
    placement: "left",
    version: 1,
  },
  {
    id: "secret-block",
    tier: "quick",
    target: '[data-tour="secret-block"]',
    title: "Secret Blocks",
    description:
      "Embed encrypted data anywhere in your notes with :::secret. One-click copy, auto-hide after 30s.",
    placement: "left",
    version: 1,
    prepare: () => {
      const { pages, openPage } = usePagesStore.getState();
      const helpPage = pages.find(
        (p) => p.meta.folder === "help" && p.meta.title.toLowerCase().includes("secret"),
      );
      if (helpPage) openPage(helpPage.path);
    },
  },
  {
    id: "generator",
    tier: "quick",
    target: '[data-tour="generator"]',
    title: "Password Generator",
    description:
      "6 modes: passwords, passphrases, memorable, PIN, UUID. With strength checker and crack-time estimates.",
    placement: "left",
    version: 1,
    prepare: () => {
      useUIStore.getState().setGeneratorOpen(true);
    },
    cleanup: () => {
      useUIStore.getState().setGeneratorOpen(false);
    },
  },
  {
    id: "help-folder",
    tier: "quick",
    target: '[data-tour="help-folder"]',
    title: "Help Pages",
    description:
      "10 built-in guides covering everything from markdown extensions to security. Start here to go deeper.",
    placement: "right",
    version: 1,
  },

  // ── Advanced Tour (9 steps) ───────────────────────
  {
    id: "encrypt-page",
    tier: "advanced",
    target: '[data-tour="encrypt-page"]',
    title: "Encrypt Whole Page",
    description:
      "Toggle full-page encryption from the inspector. Title stays searchable, content is fully encrypted.",
    placement: "left",
    version: 1,
    prepare: () => {
      useUIStore.getState().setInspectorOpen(true);
    },
  },
  {
    id: "search",
    tier: "advanced",
    target: '[data-tour="search"]',
    title: "Search",
    description:
      "Cmd+K for instant search. Filter by folder, secrets-only, or search across everything.",
    placement: "bottom",
    version: 1,
    prepare: () => {
      useUIStore.getState().setInspectorOpen(false);
      useSearchStore.getState().open();
    },
    cleanup: () => {
      useSearchStore.getState().close();
    },
  },
  {
    id: "sharing",
    tier: "advanced",
    target: '[data-tour="sharing"]',
    title: "Sharing",
    description:
      "Share pages or secrets as encrypted, expiring links. Recipients need the password you set.",
    placement: "left",
    version: 1,
    prepare: () => {
      useUIStore.getState().setInspectorOpen(true);
    },
  },
  {
    id: "tags",
    tier: "advanced",
    target: '[data-tour="tags"]',
    title: "Tags",
    description:
      "Add tags for cross-folder organization. Autocomplete from existing tags.",
    placement: "left",
    version: 1,
    prepare: () => {
      useUIStore.getState().setInspectorOpen(true);
    },
  },
  {
    id: "pin-archive",
    tier: "advanced",
    target: '[data-tour="pin-archive"]',
    title: "Pin & Archive",
    description:
      "Pin important pages to the top. Archive old ones to declutter without deleting.",
    placement: "left",
    version: 1,
    prepare: () => {
      useUIStore.getState().setInspectorOpen(true);
    },
  },
  {
    id: "git-history",
    tier: "advanced",
    target: '[data-tour="git-history"]',
    title: "Version History",
    description:
      "Every save is auto-committed. Browse history, view diffs, restore any version.",
    placement: "left",
    version: 1,
    prepare: () => {
      useUIStore.getState().setInspectorOpen(true);
    },
    cleanup: () => {
      useUIStore.getState().setInspectorOpen(false);
    },
  },
  {
    id: "biometric",
    tier: "advanced",
    target: '[data-tour="biometric"]',
    title: "Biometric Unlock",
    description:
      "Use Touch ID, Windows Hello, or Face ID to unlock instead of typing your password.",
    placement: "left",
    version: 1,
  },
  {
    id: "integrations",
    tier: "advanced",
    target: '[data-tour="integrations"]',
    title: "MCP, API & CLI",
    description:
      "Connect AI tools via MCP server, automate with the REST API, or use the CLI.",
    placement: "left",
    version: 1,
  },
  {
    id: "import",
    tier: "advanced",
    target: '[data-tour="import"]',
    title: "Import",
    description:
      "Bring in data from LastPass, 1Password, KeePass, CSV, or markdown files.",
    placement: "left",
    version: 1,
  },
];

export function getQuickSteps(): TourStep[] {
  return TOUR_STEPS.filter((s) => s.tier === "quick");
}

export function getAdvancedSteps(): TourStep[] {
  return TOUR_STEPS.filter((s) => s.tier === "advanced");
}

export function getNewSteps(lastSeenVersion: number): TourStep[] {
  return TOUR_STEPS.filter((s) => s.version > lastSeenVersion);
}
