// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Extension registration index.
 *
 * Import this file once (e.g., in main.tsx) to register all built-in
 * extensions with the registry. Extensions self-register via
 * registerExtension() on import.
 */

// Core (enabled by default)
import "./callouts";
import "./math";
import "./footnotes";
import "./mermaid";

import "./wikilinks";

// Diagrams & visuals (disabled by default, opt-in)
import "./charts";
import "./graphviz";
import "./toc";

// Planning (disabled by default, opt-in)
import "./kanban";
import "./spreadsheet";
import "./timelines";

// Science
import "./chemical";

// Media
import "./music";
import "./embeds";

// Document
import "./presentations";
