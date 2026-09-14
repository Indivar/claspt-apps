// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { StepHeading, StepFooter } from "@/components/setup/WizardFrame";

export function WelcomeStep({
  onNext,
  onSkip,
}: {
  onNext: () => void;
  onSkip: () => void;
}) {
  return (
    <>
      <StepHeading eyebrow="Getting started" title="Welcome to Claspt">
        Claspt keeps your passwords, notes and keys in one place, encrypted on this
        computer. There is no account to create, and nothing is sent anywhere unless you
        choose to turn on syncing.
      </StepHeading>

      <div className="border-l-2 border-accent/40 pl-4">
        <p className="mb-1.5 text-[14px] font-semibold text-text-primary">Next we will</p>
        <p className="text-[14px] leading-relaxed text-text-secondary">
          Save your recovery key, ask what you want to use Claspt for, and then set up
          only the things you choose. This takes a minute or two, and you can change any
          of it later in Settings.
        </p>
      </div>

      <StepFooter>
        <button
          type="button"
          onClick={onSkip}
          className="px-1 py-2 text-[13px] text-text-muted transition-colors hover:text-text-secondary"
        >
          Skip setup
        </button>
        <button
          type="button"
          onClick={onNext}
          className="btn-accent rounded-xl px-7 py-3 text-[13px]"
        >
          Get started
        </button>
      </StepFooter>
    </>
  );
}
