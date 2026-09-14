// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { useState } from "react";
import { StepHeading, StepFooter } from "@/components/setup/WizardFrame";
import { copyToClipboard } from "@/lib/clipboard";

export function RecoveryKeyStep({
  recoveryKey,
  onNext,
  onBack,
}: {
  recoveryKey: string;
  onNext: () => void;
  onBack: () => void;
}) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

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

      <div className="mb-6 flex gap-2.5">
        <button
          type="button"
          onClick={() => {
            void copyToClipboard(recoveryKey);
            setCopied(true);
          }}
          className="rounded-xl border border-border/60 bg-surface px-4 py-2.5 text-[13px] font-medium text-text-secondary transition-colors hover:bg-surface-overlay/60"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

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
