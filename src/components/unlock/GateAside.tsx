// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * The left half of the vault gate: what Claspt is, and what a vault looks like.
 *
 * The specimen sits inside a framed window rather than loose on the panel.
 * Unframed, it read as stray text somewhere between decoration and an error —
 * there was nothing to say "this is a picture of your vault" rather than "this
 * is part of the page". The frame, with the vault's path in its title bar, is
 * what makes it legible as an example.
 *
 * Beneath it, one feature card at a time (see GateCards), starting with the
 * same three points in words, because a file tree only lands for a reader who
 * already knows what they are looking at.
 *
 * The secret seals once, on load: the note stays readable, the value inside the
 * block does not. It is the only motion here, and `prefers-reduced-motion`
 * renders the sealed state directly.
 */
import { BrandLogo } from "@/components/BrandLogo";
import { GateCards } from "@/components/unlock/GateCards";

export function GateAside() {
  return (
    <div className="w-full max-w-[420px]">
      <div className="mb-8 flex items-center gap-4">
        <BrandLogo size="unlock" className="h-[76px] w-[76px] shrink-0" />
        <div>
          <p className="text-[30px] font-bold leading-none tracking-tight text-text-primary">
            Claspt
          </p>
          <p className="mt-2 max-w-[34ch] text-[14px] leading-snug text-text-secondary">
            Encrypted notes and credentials, for you and your AI agents.
          </p>
        </div>
      </div>

      <GateCards />
    </div>
  );
}
