// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * TourCompletionCard — modal shown after the user finishes the Quick Tour.
 * Offers two paths: start using the app, or continue into the Advanced Tour.
 */
import { getAdvancedSteps } from "./tour-steps";

interface TourCompletionCardProps {
  /** Dismiss the tour and let the user begin writing. */
  onStartWriting: () => void;
  /** Launch the Advanced Tour tier. */
  onContinueAdvanced: () => void;
}

/**
 * Congratulatory card rendered once the Quick Tour completes. Displays the
 * number of remaining Advanced steps so the user knows how much more there is.
 */
export function TourCompletionCard({
  onStartWriting,
  onContinueAdvanced,
}: TourCompletionCardProps) {
  const advancedCount = getAdvancedSteps().length;

  return (
    <div className="fixed inset-0 z-[10001] flex items-center justify-center">
      <div className="w-full max-w-sm rounded-xl border border-amber-400/30 bg-zinc-800 p-6 shadow-[0_8px_32px_rgba(0,0,0,0.4)]">
        <div className="mb-4 text-center">
          <div className="mb-2 text-3xl">&#127881;</div>
          <h2 className="mb-1 text-lg font-semibold text-white">You're all set!</h2>
          <p className="text-xs leading-relaxed text-zinc-400">
            You know the essentials. Start creating pages or explore more features.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <button
            onClick={onStartWriting}
            className="w-full rounded-lg bg-amber-400 px-4 py-2.5 text-sm font-semibold text-zinc-900 hover:bg-amber-300"
          >
            Start Writing
          </button>
          <button
            onClick={onContinueAdvanced}
            className="w-full rounded-lg border border-amber-400/30 bg-amber-400/10 px-4 py-2.5 text-sm text-amber-400 hover:bg-amber-400/20"
          >
            Continue &rarr; Advanced Features ({advancedCount} more steps)
          </button>
        </div>

        <p className="mt-3 text-center text-[11px] text-zinc-600">
          You can restart this tour anytime from Settings
        </p>
      </div>
    </div>
  );
}
