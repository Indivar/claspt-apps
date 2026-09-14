// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * ExtensionToolbar — secondary editor toolbar row for enabled markdown
 * extensions.
 *
 * Renders an insert button for each enabled extension that defines both a
 * toolbar insert snippet and an icon, ordered by `toolbarOrder`. Clicking a
 * button inserts the extension's snippet at the cursor. Renders nothing when
 * no eligible extensions are enabled.
 */
import { useExtensionStore } from "@/stores/extension-store";
import { insertAtCursor } from "./editor-api";

/** Row of insert buttons for enabled markdown extensions. */
export function ExtensionToolbar() {
  const { enabledExtensions } = useExtensionStore();

  // Only show extensions that have toolbar inserts and icons
  const buttons = enabledExtensions
    .filter((ext) => ext.toolbarInsert && ext.iconPath)
    .sort((a, b) => a.toolbarOrder - b.toolbarOrder);

  if (buttons.length === 0) return null;

  return (
    <div className="flex items-center gap-0.5 border-t border-border/40 px-4 py-1">
      <span className="mr-1 text-[9px] font-medium uppercase tracking-wider text-text-muted/50">
        Extensions
      </span>
      {buttons.map((ext) => (
        <button
          key={ext.id}
          onClick={() => insertAtCursor(ext.toolbarInsert!)}
          title={`Insert ${ext.name}`}
          className="icon-btn p-1.5 text-text-muted"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
            <path d={ext.iconPath} />
          </svg>
        </button>
      ))}
    </div>
  );
}
