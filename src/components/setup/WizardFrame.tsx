// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * The shell every setup step is drawn in: branding and illustration panel on the
 * left, content on the right, progress dots at the foot.
 *
 * Steps supply only their own content, so spacing, type scale and the panel
 * treatment cannot drift between them. The panel reuses the unlock screen's grid
 * and glow (`.unlock-bg`) so the walkthrough reads as a continuation of the
 * screen the user just came from rather than a different product.
 */
import type { ReactNode } from "react";
import { BrandLogo } from "@/components/BrandLogo";
import { APP_VERSION, GIT_DATE } from "@/lib/version";

/** `2026-09-04` → `4 September 2026`. Falls back to the raw value if unparsable. */
function readableDate(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export function WizardFrame({
  stepNumber,
  stepCount,
  aside,
  children,
}: {
  stepNumber: number;
  stepCount: number;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 dark:bg-black/50">
      <div className="flex h-[660px] w-[1000px] overflow-hidden rounded-2xl border border-border/60 bg-surface shadow-2xl">
        {/* Illustration and branding */}
        <aside className="unlock-bg flex w-[372px] shrink-0 flex-col border-r border-border/60 px-8 pb-10 pt-7">
          <div className="relative flex items-center gap-3">
            <BrandLogo size="icon" />
            <div>
              <p className="text-[16px] font-bold leading-tight tracking-tight text-text-primary">
                Claspt
              </p>
              <p className="mt-0.5 text-[11px] leading-tight text-text-muted">
                Version {APP_VERSION} · {readableDate(GIT_DATE)}
              </p>
            </div>
          </div>
          <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center gap-6">
            {aside}
          </div>
        </aside>

        {/* Content */}
        <div className="flex min-w-0 flex-1 flex-col px-11 pb-8 pt-11">{children}</div>
      </div>

      {/* Progress, drawn over the content column's padding */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className="h-[660px] w-[1000px]">
          <div className="flex h-full items-end justify-start pb-8 pl-[416px]">
            <ol
              className="flex list-none items-center gap-[7px]"
              aria-label="Setup progress"
            >
              {Array.from({ length: stepCount }, (_, i) => {
                const done = i < stepNumber - 1;
                const active = i === stepNumber - 1;
                return (
                  <li
                    key={i}
                    aria-current={active ? "step" : undefined}
                    className={
                      active
                        ? "h-[5px] w-[22px] rounded-full bg-accent"
                        : done
                          ? "h-[5px] w-[5px] rounded-full bg-accent/45"
                          : "h-[5px] w-[5px] rounded-full bg-border"
                    }
                  />
                );
              })}
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Shared heading block, so every step's hierarchy matches. */
export function StepHeading({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="mb-6">
      <p className="mb-2.5 text-[11.5px] font-semibold uppercase tracking-[0.09em] text-text-muted">
        {eyebrow}
      </p>
      <h1 className="mb-3.5 text-[31px] font-bold leading-[1.15] tracking-tight text-text-primary text-balance">
        {title}
      </h1>
      {children && (
        <p className="max-w-[48ch] text-[15px] leading-relaxed text-text-secondary text-pretty">
          {children}
        </p>
      )}
    </div>
  );
}

/** Shared footer row: quiet action on the left of the primary one. */
export function StepFooter({ children }: { children: ReactNode }) {
  return (
    <div className="mt-auto flex items-center justify-end gap-3.5 pt-4">{children}</div>
  );
}
