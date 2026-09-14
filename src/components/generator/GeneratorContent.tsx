// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * GeneratorContent — the generator modal shell.
 *
 * Hosts the left-hand tab navigation (Password, Passphrase, Memorable, PIN,
 * UUID, Strength) and renders the active tab's panel. Also exposes a "Bulk
 * Generate..." action and clears the clipboard on close to avoid leaving
 * generated secrets behind. When opened from a secret field, `onUseValue`
 * (derived from the UI store's `generatorFieldCallback`) lets a tab insert its
 * value straight back into that field.
 */
import { useCallback, useState } from "react";
import { useUIStore } from "@/stores/ui-store";
import { useEscapeClose } from "@/hooks/use-escape-close";
import { CloseIcon } from "@/components/ui/icons";
import { PasswordTab } from "./PasswordTab";
import { copyToClipboard } from "@/lib/clipboard";
import { PassphraseTab } from "./PassphraseTab";
import { MemorableTab } from "./MemorableTab";
import { PinTab } from "./PinTab";
import { UuidTab } from "./UuidTab";
import { StrengthTab } from "./StrengthTab";
import { BulkGenerateModal } from "./BulkGenerateModal";
import { GeneratedHistoryTab } from "./GeneratedHistoryTab";
import { markGeneratedValueUsed } from "@/lib/generated-history";

type Tab =
  | "password"
  | "passphrase"
  | "memorable"
  | "pin"
  | "uuid"
  | "strength"
  | "history";

const TABS: { key: Tab; label: string }[] = [
  { key: "password", label: "Password" },
  { key: "passphrase", label: "Passphrase" },
  { key: "memorable", label: "Memorable" },
  { key: "pin", label: "PIN" },
  { key: "uuid", label: "UUID" },
  { key: "strength", label: "Strength" },
  { key: "history", label: "History" },
];

/** Generator modal: tab sidebar + active generator panel. */
export function GeneratorContent() {
  const { setGeneratorOpen, generatorFieldCallback } = useUIStore();
  const [tab, setTab] = useState<Tab>("password");
  const [bulkOpen, setBulkOpen] = useState(false);

  const handleClose = useCallback(() => {
    // Clear clipboard on close
    copyToClipboard("");
    setGeneratorOpen(false);
  }, [setGeneratorOpen]);

  useEscapeClose(handleClose);

  const handleUseValue = useCallback(
    (value: string) => {
      if (generatorFieldCallback) {
        // Every tab's Insert funnels through here, so marking the entry used
        // once at this point covers all of them.
        void markGeneratedValueUsed(value).catch(() => {});
        generatorFieldCallback(value);
        setGeneratorOpen(false);
      }
    },
    [generatorFieldCallback, setGeneratorOpen],
  );

  const onUseValue = generatorFieldCallback ? handleUseValue : undefined;

  return (
    <>
      <div className="modal-overlay fixed inset-0 z-[55] flex items-center justify-center bg-black/40 dark:bg-black/60">
        <div className="generator-dialog modal-card flex h-[520px] w-[680px] overflow-hidden rounded-2xl border border-border bg-surface">
          {/* Tab sidebar */}
          <div className="flex w-40 shrink-0 flex-col border-r border-border bg-surface-raised p-3">
            <h2 className="mb-4 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
              Generator
            </h2>
            <nav className="space-y-0.5">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  className={`w-full rounded-lg px-3 py-2 text-left text-[13px] transition-all ${
                    tab === t.key
                      ? "bg-accent/10 font-medium text-accent"
                      : "text-text-secondary hover:bg-surface-overlay"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </nav>
            <div className="mt-auto pt-3">
              <button
                onClick={() => setBulkOpen(true)}
                className="w-full rounded-lg border border-border/60 px-3 py-2 text-[12px] text-text-secondary transition-all hover:bg-surface-overlay active:scale-95"
              >
                Bulk Generate...
              </button>
            </div>
          </div>

          {/* Content */}
          <div className="flex flex-1 flex-col">
            <div className="flex items-center justify-between border-b border-border/60 px-5 py-3">
              <h3 className="text-[13px] font-semibold text-text-primary">
                {TABS.find((t) => t.key === tab)?.label}
              </h3>
              <button onClick={handleClose} className="icon-btn p-1 text-text-muted">
                <CloseIcon />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4">
              {tab === "password" && <PasswordTab onUseValue={onUseValue} />}
              {tab === "passphrase" && <PassphraseTab onUseValue={onUseValue} />}
              {tab === "memorable" && <MemorableTab onUseValue={onUseValue} />}
              {tab === "pin" && <PinTab onUseValue={onUseValue} />}
              {tab === "uuid" && <UuidTab onUseValue={onUseValue} />}
              {tab === "strength" && <StrengthTab />}
              {tab === "history" && <GeneratedHistoryTab />}
            </div>
          </div>
        </div>
      </div>

      {bulkOpen && <BulkGenerateModal onClose={() => setBulkOpen(false)} />}
    </>
  );
}
