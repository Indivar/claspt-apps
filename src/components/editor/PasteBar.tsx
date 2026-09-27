// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * The strip that appears when a paste brought in lines that look like
 * credentials. It offers the conversion before the first autosave, so the
 * values can go straight into a secret block. It never blocks typing.
 */

interface PasteBarProps {
  count: number;
  onConvert: () => void;
  onDismiss: () => void;
}

export function PasteBar({ count, onConvert, onDismiss }: PasteBarProps) {
  const lines =
    count === 1
      ? "1 line that looks like a credential"
      : `${count} lines that look like credentials`;
  return (
    <div
      role="status"
      className="flex items-center gap-2.5 border-b border-accent/30 bg-accent/10 px-6 py-2 text-[12px] text-text-primary"
    >
      <span>This paste has {lines}.</span>
      <div className="ml-auto flex shrink-0 gap-2">
        <button
          type="button"
          onClick={onConvert}
          className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-white transition-all hover:bg-accent-hover active:scale-95"
        >
          Convert to a secret
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded-md border border-border/60 px-2.5 py-1 text-[12px] font-medium text-text-secondary transition-all hover:bg-surface-overlay"
        >
          Not now
        </button>
      </div>
    </div>
  );
}
