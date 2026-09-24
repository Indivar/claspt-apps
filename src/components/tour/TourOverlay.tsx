// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * TourOverlay — the root controller for the in-app onboarding tour.
 *
 * Reads tour state from the UI store (active flag, current step, tier) and
 * renders the dimmed overlay with a spotlight cutout around the current step's
 * target element, a highlight ring, and the {@link TourTooltip}. Also owns tour
 * lifecycle side effects: running each step's prepare()/cleanup() hooks,
 * auto-advancing past missing targets, keyboard navigation, focus trapping, and
 * persisting that the tour has been seen.
 */
import { useEffect, useRef, useState } from "react";
import { useUIStore } from "@/stores/ui-store";
import { getLicenseStatus } from "@/lib/commands";
import {
  getQuickSteps,
  getAdvancedSteps,
  CURRENT_TOUR_VERSION,
  type TourStep,
} from "./tour-steps";
import { useTooltipPosition } from "./use-tooltip-position";
import { TourTooltip } from "./TourTooltip";
import { TourCompletionCard } from "./TourCompletionCard";
import { useVaultStore } from "@/stores/vault-store";

export function TourOverlay() {
  const { tourActive, tourStep, tourTier, setTourActive, prevTourStep, startTour } =
    useUIStore();
  const tooltipRef = useRef<HTMLDivElement>(null);
  const prevStepRef = useRef<TourStep | null>(null);

  // The tour is built for the plan in hand: a step that points at a control a
  // free user does not have is a promise the app cannot keep.
  const [hasPro, setHasPro] = useState(false);
  useEffect(() => {
    let cancelled = false;
    getLicenseStatus()
      .then((status) => {
        if (!cancelled) setHasPro(status.is_pro && !status.is_expired);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const steps = tourTier === "quick" ? getQuickSteps(hasPro) : getAdvancedSteps(hasPro);
  const currentStep = steps[tourStep];
  const isLast = tourStep === steps.length - 1;
  const showCompletion = tourTier === "quick" && tourStep >= steps.length;

  // Run cleanup on previous step and prepare on current step when step changes
  useEffect(() => {
    // Cleanup the previous step's UI state (e.g. close generator, close inspector)
    if (prevStepRef.current?.cleanup) {
      prevStepRef.current.cleanup();
    }
    prevStepRef.current = currentStep ?? null;

    if (tourActive && currentStep?.prepare) {
      currentStep.prepare();
    }
  }, [tourActive, tourStep, tourTier]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup when tour ends (dismiss, complete, or deactivate)
  useEffect(() => {
    if (!tourActive && prevStepRef.current?.cleanup) {
      prevStepRef.current.cleanup();
      prevStepRef.current = null;
    }
  }, [tourActive]);

  const { position, targetRect } = useTooltipPosition(
    currentStep?.target ?? null,
    currentStep?.placement ?? "right",
    tourActive && !showCompletion,
  );

  // Auto-advance when target not found after a delay.
  // Steps with prepare() get extra time for async UI changes (e.g. opening a page).
  useEffect(() => {
    if (!tourActive || showCompletion || !currentStep) return;
    if (!position && !targetRect) {
      const delay = currentStep.prepare ? 1500 : 400;
      const timer = setTimeout(() => {
        const el = document.querySelector(currentStep.target);
        if (!el) {
          useUIStore.getState().nextTourStep();
        }
      }, delay);
      return () => clearTimeout(timer);
    }
  }, [tourActive, tourStep, tourTier, position, targetRect]); // eslint-disable-line react-hooks/exhaustive-deps

  // Focus trap — keep focus within tooltip
  useEffect(() => {
    if (!tourActive || !tooltipRef.current) return;
    tooltipRef.current.focus();

    function trapFocus(e: KeyboardEvent) {
      if (e.key !== "Tab" || !tooltipRef.current) return;
      const focusable = tooltipRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", trapFocus);
    return () => document.removeEventListener("keydown", trapFocus);
  }, [tourActive, tourStep]);

  /** Mark tour as seen in both Zustand store and disk config.
   *  Using updateConfig() ensures the store stays in sync — raw IPC writes
   *  would leave the store stale, and the next settings save would overwrite
   *  tour_version_seen back to undefined. */
  async function markTourSeen() {
    const { config, updateConfig } = useVaultStore.getState();
    if (!config) return;
    await updateConfig({ ...config, tour_version_seen: CURRENT_TOUR_VERSION });
  }

  /** Mark tour as completed */
  async function completeTour() {
    setTourActive(false);
    try {
      await markTourSeen();
    } catch {
      /* non-critical */
    }
  }

  /** Dismiss — also marks tour as seen so it doesn't keep repeating on every launch */
  function dismissTour() {
    setTourActive(false);
    markTourSeen().catch(() => {});
  }

  function handleNext() {
    const state = useUIStore.getState();
    const currentSteps =
      state.tourTier === "quick" ? getQuickSteps(hasPro) : getAdvancedSteps(hasPro);
    const atLast = state.tourStep === currentSteps.length - 1;

    if (atLast) {
      if (state.tourTier === "quick") {
        state.nextTourStep(); // advance past last to show completion card
      } else {
        completeTour();
      }
    } else {
      state.nextTourStep();
    }
  }

  function handleStartWriting() {
    completeTour();
  }

  function handleContinueAdvanced() {
    startTour("advanced");
  }

  // Keyboard navigation — uses getState() to avoid stale closures
  useEffect(() => {
    if (!tourActive) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Tab") return; // handled by focus trap
      const state = useUIStore.getState();
      if (!state.tourActive) return;
      if (e.key === "Escape") {
        dismissTour();
      } else if (e.key === "ArrowRight" || e.key === "Enter") {
        e.preventDefault();
        handleNext();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        state.prevTourStep();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [tourActive]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!tourActive) return null;

  // Completion card (after Quick Tour)
  if (showCompletion) {
    return (
      <>
        <div className="fixed inset-0 z-[10000] bg-black/60" />
        <TourCompletionCard
          onStartWriting={handleStartWriting}
          onContinueAdvanced={handleContinueAdvanced}
        />
      </>
    );
  }

  // No target found — overlay shown briefly while auto-advance fires
  if (!position || !targetRect) {
    return <div className="fixed inset-0 z-[10000] bg-black/60" />;
  }

  // SVG mask for the spotlight cutout
  const pad = 8;
  const rx = 8;

  return (
    <>
      {/* Overlay with cutout */}
      <svg
        className="fixed inset-0 z-[10000]"
        width="100%"
        height="100%"
        style={{ pointerEvents: "auto" }}
      >
        <defs>
          <mask id="tour-spotlight">
            <rect width="100%" height="100%" fill="white" />
            <rect
              x={targetRect.left - pad}
              y={targetRect.top - pad}
              width={targetRect.width + pad * 2}
              height={targetRect.height + pad * 2}
              rx={rx}
              fill="black"
            />
          </mask>
        </defs>
        <rect
          width="100%"
          height="100%"
          fill="rgba(0,0,0,0.6)"
          mask="url(#tour-spotlight)"
        />
      </svg>

      {/* Highlight ring around target */}
      <div
        className="pointer-events-none fixed z-[10000] rounded-lg ring-2 ring-amber-400 ring-offset-2 ring-offset-transparent"
        style={{
          top: targetRect.top - pad,
          left: targetRect.left - pad,
          width: targetRect.width + pad * 2,
          height: targetRect.height + pad * 2,
          transition: "all 200ms ease",
        }}
      />

      {/* Tooltip */}
      <TourTooltip
        ref={tooltipRef}
        step={currentStep!}
        stepIndex={tourStep}
        totalSteps={steps.length}
        position={position}
        onNext={handleNext}
        onPrev={prevTourStep}
        onSkip={dismissTour}
        isLast={isLast}
      />
    </>
  );
}
