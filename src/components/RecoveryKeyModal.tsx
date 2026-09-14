// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * One-time modal that surfaces the vault recovery key after creation.
 *
 * The recovery key can reset the master password if it is forgotten, so this
 * is the only moment it is ever shown in plaintext. It renders only while
 * `recoveryKey` is present in the vault store; dismissing it (via "I've Saved
 * It") calls `clearRecoveryKey`, permanently removing it from memory.
 */
import { useVaultStore } from "@/stores/vault-store";
import { copyToClipboard, clearClipboardAfter } from "@/lib/clipboard";

/** Modal shown once after vault creation to display the recovery key. */
export function RecoveryKeyModal() {
  const { recoveryKey, clearRecoveryKey, config } = useVaultStore();

  if (!recoveryKey) return null;
  // The first-run walkthrough presents the key as a step of its own, so this
  // modal stands down while that is running rather than stacking on top of it
  // and asking for the same thing twice.
  if (config && (config.setup_version_seen ?? null) === null) return null;

  return (
    <div className="modal-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/30 dark:bg-black/50">
      <div className="modal-card w-full max-w-lg rounded-2xl border border-border/60 bg-surface-raised p-8">
        <h2 className="text-lg font-bold tracking-tight text-text-primary">
          Recovery Key
        </h2>
        <p className="mt-2 text-[13px] leading-relaxed text-text-secondary">
          Save this recovery key somewhere safe. You will need it if you forget your
          master password. This is the only time it will be shown.
        </p>

        <div className="mt-4 rounded-xl border border-accent/30 bg-secret-bg p-4">
          <code className="block break-all text-[13px] leading-relaxed text-text-primary">
            {recoveryKey}
          </code>
        </div>

        <div className="mt-6 flex justify-end gap-3">
          <button
            onClick={() => {
              // Auto-clear the clipboard after 30s so the key doesn't linger there.
              copyToClipboard(recoveryKey);
              clearClipboardAfter(30_000);
            }}
            className="rounded-lg border border-border/60 px-4 py-2 text-[13px] text-text-secondary transition-all hover:bg-surface-overlay active:scale-95"
          >
            Copy to Clipboard
          </button>
          <button
            onClick={clearRecoveryKey}
            className="rounded-lg bg-accent px-5 py-2 text-[13px] font-medium text-white transition-all hover:bg-accent-hover hover:shadow-md active:scale-95"
          >
            I&apos;ve Saved It
          </button>
        </div>
      </div>
    </div>
  );
}
