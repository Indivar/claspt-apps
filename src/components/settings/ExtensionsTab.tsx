// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * ExtensionsTab — settings panel for enabling/disabling markdown rendering
 * extensions (KaTeX, Mermaid, footnotes, etc.). Toggles update the extension
 * store for immediate preview effect and persist the enabled map to vault config.
 */
import { useExtensionStore } from "@/stores/extension-store";
import { useVaultStore } from "@/stores/vault-store";
import { getExtensionsByCategory } from "@/lib/extensions/registry";
import { SectionHeader } from "@/components/ui/SectionHeader";
import type { ExtensionId } from "@/lib/extensions/types";

/** Grouped list of markdown extensions with per-extension and enable-all toggles. */
export function ExtensionsTab() {
  const { enabledMap, toggle, setAll } = useExtensionStore();
  const { config, updateConfig } = useVaultStore();
  const groups = getExtensionsByCategory();

  const allIds = groups.flatMap((g) => g.extensions.map((e) => e.id));
  const allEnabled =
    allIds.length > 0 && allIds.every((id) => enabledMap[id as ExtensionId] === true);

  /** Toggle extension and persist to vault config. */
  function handleToggle(id: ExtensionId) {
    const newMap = toggle(id);
    if (config) {
      updateConfig({ ...config, markdown_extensions: newMap });
    }
  }

  /** Enable or disable all extensions at once. */
  function handleToggleAll() {
    const newMap = setAll(!allEnabled);
    if (config) {
      updateConfig({ ...config, markdown_extensions: newMap });
    }
  }

  return (
    <>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-[12px] leading-relaxed text-text-muted">
          Enable or disable markdown extensions. Changes take effect immediately in the
          preview pane.
        </p>
        <label className="flex shrink-0 cursor-pointer items-center gap-2 ml-4">
          <span className="text-[12px] font-medium text-text-secondary">
            {allEnabled ? "All on" : "Enable all"}
          </span>
          <ToggleSwitch checked={allEnabled} onChange={handleToggleAll} />
        </label>
      </div>
      {groups.map(
        (group) =>
          group.extensions.length > 0 && (
            <div key={group.category}>
              <SectionHeader title={group.label} />
              <div className="space-y-0.5">
                {group.extensions.map((ext) => (
                  <label
                    key={ext.id}
                    className="flex cursor-pointer items-center justify-between rounded-lg px-2 py-2 transition-colors hover:bg-surface-overlay/50"
                  >
                    <div className="flex items-center gap-3">
                      {ext.iconPath && (
                        <svg
                          viewBox="0 0 24 24"
                          width="16"
                          height="16"
                          fill="currentColor"
                          className="shrink-0 text-text-muted"
                        >
                          <path d={ext.iconPath} />
                        </svg>
                      )}
                      <div>
                        <span className="text-[13px] font-medium text-text-primary">
                          {ext.name}
                        </span>
                        <p className="text-[11px] text-text-muted">{ext.description}</p>
                      </div>
                    </div>
                    <ToggleSwitch
                      checked={enabledMap[ext.id as ExtensionId] === true}
                      onChange={() => handleToggle(ext.id)}
                    />
                  </label>
                ))}
              </div>
            </div>
          ),
      )}
    </>
  );
}

/** Small accessible on/off switch used for each extension row. */
function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={onChange}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
        checked ? "bg-accent" : "bg-border"
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-4" : ""
        }`}
      />
    </button>
  );
}
