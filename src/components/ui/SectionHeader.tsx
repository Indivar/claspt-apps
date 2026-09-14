// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * SectionHeader — small uppercase heading with an underline, used to separate
 * groups of controls within settings and other form-style panels.
 */
export function SectionHeader({ title }: { title: string }) {
  return (
    <h3 className="mb-2 mt-5 border-b border-border/40 pb-1.5 text-[10px] font-semibold uppercase tracking-widest text-text-muted/60 first:mt-0">
      {title}
    </h3>
  );
}
