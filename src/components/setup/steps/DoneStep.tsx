// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { StepHeading, StepFooter } from "@/components/setup/WizardFrame";
import { USE_CASES, type UseCaseId } from "@/components/setup/use-cases";

export function DoneStep({
  chosen,
  onFinish,
}: {
  chosen: UseCaseId[];
  onFinish: (startTour: boolean) => void;
}) {
  return (
    <>
      <StepHeading eyebrow="All set" title="You are ready to go">
        Here is what is now set up. Anything you skipped can be added later in Settings,
        and you can run this walkthrough again from there.
      </StepHeading>

      <ul className="mb-6 flex list-none flex-col gap-2">
        {USE_CASES.map((uc) => {
          const on = chosen.includes(uc.id);
          return (
            <li
              key={uc.id}
              className={`flex items-center gap-3 text-[14px] ${on ? "text-text-secondary" : "text-text-muted"}`}
            >
              <span
                aria-hidden="true"
                className={`inline-block h-2 w-2 shrink-0 rounded-full ${on ? "bg-success" : "bg-border"}`}
              />
              <span>
                <strong className="font-semibold text-text-primary">{uc.title}</strong>
                {on ? "" : " — not set up"}
              </span>
            </li>
          );
        })}
      </ul>

      {/* The tour is offered, never forced. It used to start on its own, which
          put a full-screen overlay in front of someone who had not yet done the
          thing they came to do. */}
      <div className="border-t border-border/50 pt-4">
        <p className="mb-2.5 text-[13.5px] text-text-secondary">
          Would you like a short tour of the app?
        </p>
        <div className="flex gap-2.5">
          <button
            type="button"
            onClick={() => onFinish(true)}
            className="rounded-xl border border-border/60 bg-surface px-4 py-2.5 text-[13px] font-medium text-text-secondary transition-colors hover:bg-surface-overlay/60"
          >
            Yes, show me around (2 minutes)
          </button>
          <button
            type="button"
            onClick={() => onFinish(false)}
            className="rounded-xl border border-border/60 bg-surface px-4 py-2.5 text-[13px] font-medium text-text-secondary transition-colors hover:bg-surface-overlay/60"
          >
            No thanks, take me to my vault
          </button>
        </div>
      </div>

      <StepFooter>
        <button
          type="button"
          onClick={() => onFinish(false)}
          className="btn-accent rounded-xl px-8 py-3 text-[13px]"
        >
          Start using Claspt
        </button>
      </StepFooter>
    </>
  );
}
