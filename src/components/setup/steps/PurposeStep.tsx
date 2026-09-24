// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { useCallback, useEffect, useRef, useState } from "react";
import { StepHeading, StepFooter } from "@/components/setup/WizardFrame";
import { USE_CASES, type UseCaseId } from "@/components/setup/use-cases";

/**
 * The screen the rest of the walkthrough branches on.
 *
 * Two options are ticked because most people want them, not because they are
 * required — untick either and its setup step disappears from the run.
 *
 * The list is taller than the frame, and the options below the fold were
 * invisible: the panel simply ended, with nothing to say it continued. It now
 * fades at the edge while there is more to see, which is the difference between
 * a list that looks finished and one that looks scrollable.
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

  const scroller = useRef<HTMLDivElement>(null);
  const [moreBelow, setMoreBelow] = useState(false);

  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    // A pixel of slack: fractional scroll heights otherwise leave the fade on
    // permanently once the list is scrolled to the end.
    setMoreBelow(el.scrollHeight - el.scrollTop - el.clientHeight > 1);
  }, []);

  useEffect(() => {
    measure();
    const el = scroller.current;
    if (!el) return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);

  return (
    <>
      <StepHeading eyebrow="What it is for" title="What will you use Claspt for?">
        Choose everything that applies — there are {USE_CASES.length} to look through. Two
        are already ticked because most people want them. We will only set up what you
        choose.
      </StepHeading>

      <div className="relative min-h-0 flex-1">
        <div
          ref={scroller}
          onScroll={measure}
          className="flex h-full flex-col gap-2.5 overflow-y-auto pb-1"
        >
          {USE_CASES.map((uc) => {
            const on = chosen.includes(uc.id);
            const Row = uc.pro ? "div" : "label";
            return (
              <Row
                key={uc.id}
                className={`flex items-start gap-3.5 rounded-xl px-4 py-3.5 transition-colors ${
                  uc.pro
                    ? "border border-dashed border-border/70 bg-surface"
                    : on
                      ? "cursor-pointer border-[1.5px] border-accent bg-accent/[0.04]"
                      : "cursor-pointer border border-border/60 bg-surface hover:bg-surface-raised/50"
                }`}
              >
                {uc.pro ? (
                  // No checkbox at all. A disabled one still invites the click
                  // that cannot do anything.
                  <span
                    aria-hidden="true"
                    className="mt-[3px] h-[19px] w-[19px] shrink-0 rounded-[5px] border border-dashed border-border"
                  />
                ) : (
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => toggle(uc.id)}
                    className="mt-0.5 h-[19px] w-[19px] shrink-0 accent-accent"
                  />
                )}
                <span className="min-w-0">
                  <span className="mb-0.5 flex flex-wrap items-center gap-2">
                    <span className="text-[14px] font-semibold text-text-primary">
                      {uc.title}
                    </span>
                    {uc.pro && (
                      <span className="rounded-full border border-accent/40 px-2 py-[1px] text-[10.5px] font-semibold text-accent">
                        Pro
                      </span>
                    )}
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
                  {uc.pro && (
                    <span className="mt-1.5 block text-[12px] leading-snug text-text-muted">
                      Not part of the free version, so there is nothing to set up here.
                      Turn it on whenever you like in Settings.
                    </span>
                  )}
                </span>
              </Row>
            );
          })}
        </div>

        {/* Says the list continues. Sits over the scroller, ignores the pointer
            so it cannot eat a click on the option beneath it. */}
        <div
          aria-hidden="true"
          className={`pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-surface to-transparent transition-opacity duration-200 ${
            moreBelow ? "opacity-100" : "opacity-0"
          }`}
        />
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
