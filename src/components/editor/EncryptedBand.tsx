// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * The strip under the title of a fully encrypted page. It stays in view while
 * the text scrolls and says exactly what is true: the page is ciphertext on
 * disk, and why. On a page sealed automatically it carries the one action
 * that changes that: converting the flagged lines into a secret block.
 */
import { LockClosedIcon } from "@/components/ui/icons";
import type { BandState } from "@/lib/at-rest";

interface EncryptedBandProps {
  band: BandState;
  onConvert: () => void;
}

export function EncryptedBand({ band, onConvert }: EncryptedBandProps) {
  return (
    <div
      role="status"
      className="flex items-center gap-2.5 border-b border-accent/30 bg-accent/10 px-6 py-2 text-[12px] text-text-primary"
    >
      <LockClosedIcon size={13} className="shrink-0 text-accent" />
      <span>{band.text}</span>
      {band.action && (
        <button
          type="button"
          onClick={onConvert}
          className="ml-auto shrink-0 rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-white transition-all hover:bg-accent-hover active:scale-95"
        >
          {band.action}
        </button>
      )}
    </div>
  );
}

/** A large, faint lock behind the text of an encrypted page. Never in the way, never the only cue. */
export function SealWatermark() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center"
    >
      <svg
        width="40%"
        height="40%"
        viewBox="0 0 16 16"
        fill="none"
        className="text-text-primary opacity-[0.04]"
      >
        <rect x="3" y="7" width="10" height="7" rx="1.5" fill="currentColor" />
        <path
          d="M5 7V5a3 3 0 016 0v2"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    </div>
  );
}
