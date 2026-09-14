// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { StepHeading, StepFooter } from "@/components/setup/WizardFrame";
import { USE_CASES, type UseCaseId } from "@/components/setup/use-cases";

/**
 * The screen the rest of the walkthrough branches on.
 *
 * Two options are ticked because most people want them, not because they are
 * required — untick either and its setup step disappears from the run.
 */
export function PurposeStep({
  chosen,
  onChange,
  onNext,
  onBack,
}: {
  chosen: UseCaseId[];
  onChange: (next: UseCaseId[]) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const toggle = (id: UseCaseId) =>
    onChange(chosen.includes(id) ? chosen.filter((c) => c !== id) : [...chosen, id]);

  return (
    <>
      <StepHeading eyebrow="What it is for" title="What will you use Claspt for?">
        Choose everything that applies. We have selected the two options that most people
        use, and you can change them. We will only set up what you choose.
      </StepHeading>

      <div className="flex flex-col gap-2.5 overflow-y-auto">
        {USE_CASES.map((uc) => {
          const on = chosen.includes(uc.id);
          return (
            <label
              key={uc.id}
              className={`flex cursor-pointer items-start gap-3.5 rounded-xl px-4 py-3.5 transition-colors ${
                on
                  ? "border-[1.5px] border-accent bg-accent/[0.04]"
                  : "border border-border/60 bg-surface hover:bg-surface-raised/50"
              }`}
            >
              <input
                type="checkbox"
                checked={on}
                onChange={() => toggle(uc.id)}
                className="mt-0.5 h-[19px] w-[19px] shrink-0 accent-accent"
              />
              <span className="min-w-0">
                <span className="mb-0.5 block text-[14px] font-semibold text-text-primary">
                  {uc.title}
                </span>
                <span className="block text-[13px] leading-normal text-text-secondary">
                  {uc.plain}
                </span>
                {/* The technical line. Someone non-technical stops above it and
                    still chooses correctly; a developer reads it and can see
                    what the product actually is. */}
                <span className="mt-1 block text-[12px] leading-snug text-text-muted">
                  {uc.detail}
                </span>
              </span>
            </label>
          );
        })}
      </div>

      <StepFooter>
        <button
          type="button"
          onClick={onBack}
          className="px-1 py-2 text-[13px] text-text-muted transition-colors hover:text-text-secondary"
        >
          Back
        </button>
        <button
          type="button"
          onClick={onNext}
          className="btn-accent rounded-xl px-7 py-3 text-[13px]"
        >
          Continue
        </button>
      </StepFooter>
    </>
  );
}
