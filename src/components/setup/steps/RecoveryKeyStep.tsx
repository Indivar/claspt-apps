// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { StepHeading, StepFooter } from "@/components/setup/WizardFrame";
import { clearClipboardAfter, copyToClipboard } from "@/lib/clipboard";
import * as cmd from "@/lib/commands";
import { useVaultStore } from "@/stores/vault-store";

/**
 * The one moment the recovery key exists.
 *
 * "Copy" alone was not enough: a clipboard lasts until the next copy, and the
 * people who need this key are the ones who will not think about it again for
 * a year. Saving writes a sheet that explains itself — which vault, when, and
 * what to do with it — and the app remembers where it went so Settings can
 * answer "where did I put it?" later. Printing is there because paper survives
 * the disk failure that makes the key necessary in the first place.
 */
export function RecoveryKeyStep({
  recoveryKey,
  onNext,
  onBack,
}: {
  recoveryKey: string;
  onNext: () => void;
  onBack: () => void;
}) {
  const vaultDir = useVaultStore((s) => s.vaultDir);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [savedTo, setSavedTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    setError(null);
    if (!vaultDir) return;
    try {
      const defaultPath = await cmd.recoveryKeyFilename(vaultDir);
      const chosen = await save({
        defaultPath,
        title: "Save your recovery key",
        filters: [{ name: "Text", extensions: ["txt"] }],
      });
      if (!chosen) return; // dialog dismissed
      const written = await cmd.saveRecoveryKey(recoveryKey, chosen, vaultDir);
      setSavedTo(written);
      // Saving it is the confirmation; making the user also tick the box after
      // doing the thing the box asks about is a pointless second step.
      setSaved(true);
    } catch (e) {
      setError(String(e));
    }
  };

  const handlePrint = async () => {
    setError(null);
    try {
      await cmd.printWindow();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <>
      <StepHeading eyebrow="Recovery key" title="Save your recovery key">
        If you forget your password, this key is the only way to get back into your vault.
        Nobody at Claspt can reset it for you, because nobody at Claspt can open your
        vault.
      </StepHeading>

      <div className="mb-3.5 rounded-xl border border-border/60 bg-surface-raised px-4.5 py-4">
        <p className="break-all font-mono text-[14px] leading-[1.9] tracking-[0.06em] text-text-primary">
          {recoveryKey}
        </p>
      </div>

      <div className="mb-3 flex flex-wrap gap-2.5">
        <button
          type="button"
          onClick={handleSave}
          className="btn-accent rounded-xl px-4 py-2.5 text-[13px]"
        >
          Save to file…
        </button>
        <button
          type="button"
          onClick={() => {
            // The master key must not sit on the clipboard indefinitely;
            // the modal that shows the key later clears it the same way.
            void copyToClipboard(recoveryKey);
            clearClipboardAfter(30_000);
            setCopied(true);
          }}
          className="rounded-xl border border-border/60 bg-surface px-4 py-2.5 text-[13px] font-medium text-text-secondary transition-colors hover:bg-surface-overlay/60"
        >
          {copied ? "Copied" : "Copy"}
        </button>
        <button
          type="button"
          onClick={handlePrint}
          className="rounded-xl border border-border/60 bg-surface px-4 py-2.5 text-[13px] font-medium text-text-secondary transition-colors hover:bg-surface-overlay/60"
        >
          Print
        </button>
      </div>

      {savedTo && (
        <p className="mb-3 max-w-[52ch] break-all text-[12px] leading-relaxed text-success">
          Saved to {savedTo}
        </p>
      )}
      {error && (
        <p className="mb-3 max-w-[52ch] rounded-lg bg-danger/10 px-3 py-2 text-[12px] leading-relaxed text-danger">
          {error}
        </p>
      )}

      <p className="mb-5 max-w-[52ch] text-[12px] leading-relaxed text-text-muted">
        Save it anywhere except inside the vault folder. Anything in there is copied to
        every device the vault syncs to, alongside the data this key unlocks.
      </p>

      <label className="flex max-w-[46ch] cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          checked={saved}
          onChange={(e) => setSaved(e.target.checked)}
          className="mt-0.5 h-[19px] w-[19px] shrink-0 accent-accent"
        />
        <span className="text-[14px] leading-normal text-text-secondary">
          I have saved my recovery key somewhere safe
        </span>
      </label>

      {/* Only ever on paper: hidden on screen, revealed by the print rules in
          index.css. Kept beside the key rather than built in the print handler
          so the two cannot say different things. */}
      <div className="print-sheet">
        <h1>Claspt recovery key</h1>
        <p>
          This is the recovery key for the Claspt vault at <strong>{vaultDir}</strong>. If
          the master password for that vault is forgotten, this key is the only way back
          into it. Nobody at Claspt can reset the password or open the vault.
        </p>
        <p>
          Anyone holding both this sheet and the vault folder can read everything in the
          vault. Keep it somewhere only you can reach.
        </p>
        <div className="print-key">{recoveryKey}</div>
        <p>
          To use it: open Claspt, choose the vault folder above, click “Forgot password?”
          on the unlock screen, paste this key, then set a new master password. The key
          does not change when the password does, so this sheet stays valid afterwards.
        </p>
      </div>

      <StepFooter>
        <button
          type="button"
          onClick={onBack}
          className="px-1 py-2 text-[13px] text-text-muted transition-colors hover:text-text-secondary"
        >
          Back
        </button>
        {/* Deliberately not skippable: without this key a forgotten password
            means the vault is gone, and the key exists only at this moment. */}
        <button
          type="button"
          onClick={onNext}
          disabled={!saved}
          className="btn-accent rounded-xl px-7 py-3 text-[13px] disabled:cursor-not-allowed disabled:opacity-50"
        >
          Continue
        </button>
      </StepFooter>
    </>
  );
}
