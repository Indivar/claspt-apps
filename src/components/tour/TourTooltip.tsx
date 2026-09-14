// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * TourTooltip — the popover card shown for each step of the onboarding tour.
 *
 * Renders the step title/description, a step counter and progress dots, and
 * Skip/Back/Next(Done) controls, plus a directional arrow pointing at the
 * highlighted target. Positioning is computed by the parent and passed in;
 * the forwarded ref exposes the card element for focus and measurement.
 */
import { forwardRef } from "react";
import type { TourStep } from "./tour-steps";

interface TourTooltipProps {
  step: TourStep;
  stepIndex: number;
  totalSteps: number;
  position: { top: number; left: number; actualPlacement: string };
  onNext: () => void;
  onPrev: () => void;
  onSkip: () => void;
  isLast: boolean;
}

export const TourTooltip = forwardRef<HTMLDivElement, TourTooltipProps>(
  function TourTooltip(
    { step, stepIndex, totalSteps, position, onNext, onPrev, onSkip, isLast },
    ref,
  ) {
    return (
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-label={`Tour step: ${step.title}`}
        aria-describedby="tour-step-description"
        className="fixed z-[10001] w-[280px] rounded-xl border border-amber-400/30 bg-zinc-800 p-4 shadow-[0_8px_32px_rgba(0,0,0,0.4)] outline-none"
        style={{ top: position.top, left: position.left }}
      >
        {/* Arrow */}
        <Arrow placement={position.actualPlacement} />

        {/* Screen reader announcement */}
        <div aria-live="polite" className="sr-only">
          Step {stepIndex + 1} of {totalSteps}: {step.title}
        </div>

        {/* Step counter */}
        <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-amber-400">
          Step {stepIndex + 1} of {totalSteps}
        </div>

        {/* Title */}
        <h3 className="mb-2 text-sm font-semibold text-white">{step.title}</h3>

        {/* Description */}
        <p
          className="mb-4 text-xs leading-relaxed text-zinc-400"
          id="tour-step-description"
        >
          {step.description}
        </p>

        {/* Footer */}
        <div className="flex items-center justify-between">
          <button onClick={onSkip} className="text-xs text-zinc-500 hover:text-zinc-300">
            Skip tour
          </button>
          <div className="flex items-center gap-2">
            {/* Dots */}
            <div className="flex gap-1">
              {Array.from({ length: totalSteps }, (_, i) => (
                <div
                  key={i}
                  className={`h-1.5 w-1.5 rounded-full ${
                    i === stepIndex ? "bg-amber-400" : "bg-zinc-600"
                  }`}
                />
              ))}
            </div>
            {/* Nav buttons */}
            {stepIndex > 0 && (
              <button
                onClick={onPrev}
                className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:text-white"
              >
                Back
              </button>
            )}
            <button
              onClick={onNext}
              className="rounded-md bg-amber-400 px-4 py-1.5 text-xs font-semibold text-zinc-900 hover:bg-amber-300"
            >
              {isLast ? "Done" : "Next"}
            </button>
          </div>
        </div>
      </div>
    );
  },
);

/** Small rotated square forming the tooltip's directional pointer. */
function Arrow({ placement }: { placement: string }) {
  const base = "absolute h-3 w-3 rotate-45 border-amber-400/30 bg-zinc-800";

  switch (placement) {
    case "right":
      return (
        <div
          className={`${base} border-b border-l`}
          style={{ left: -6, top: "50%", marginTop: -6 }}
        />
      );
    case "left":
      return (
        <div
          className={`${base} border-r border-t`}
          style={{ right: -6, top: "50%", marginTop: -6 }}
        />
      );
    case "bottom":
      return (
        <div
          className={`${base} border-l border-t`}
          style={{ top: -6, left: "50%", marginLeft: -6 }}
        />
      );
    case "top":
      return (
        <div
          className={`${base} border-b border-r`}
          style={{ bottom: -6, left: "50%", marginLeft: -6 }}
        />
      );
    default:
      return null;
  }
}
