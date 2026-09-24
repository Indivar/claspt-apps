// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * The shell every setup step is drawn in: branding and progress on the left,
 * content on the right.
 *
 * Steps supply only their own content, so spacing, type scale and the panel
 * treatment cannot drift between them. The panel reuses the vault gate's grid
 * and glow (`.unlock-bg`) so the walkthrough reads as a continuation of the
 * screen the user just came from rather than a different product.
 *
 * That panel used to hold a 40px logo and then several hundred pixels of
 * nothing, while the only clue to progress was six dots at the foot of the
 * content column. It now carries the wordmark at the size the gate uses, and
 * the list of steps this person will actually see, with the current one marked.
 * Someone midway through can read where they are and how much is left, which
 * the dots never told them.
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
  stepLabels,
  aside,
  children,
}: {
  stepNumber: number;
  stepCount: number;
  /** One label per step, in order. Falls back to dots when not supplied. */
  stepLabels?: string[];
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 dark:bg-black/50">
      <div className="flex h-[660px] w-[1000px] overflow-hidden rounded-2xl border border-border/60 bg-surface shadow-2xl">
        {/* Branding and progress */}
        <aside className="unlock-bg flex w-[372px] shrink-0 flex-col border-r border-border/60 px-9 pb-10 pt-9">
          <div className="relative flex items-center gap-3.5">
            <BrandLogo size="unlock" className="h-[64px] w-[64px] shrink-0" />
            <div className="min-w-0">
              <p className="text-[25px] font-bold leading-none tracking-tight text-text-primary">
                Claspt
              </p>
              <p className="mt-1.5 text-[11.5px] leading-tight text-text-muted">
                Version {APP_VERSION} · {readableDate(GIT_DATE)}
              </p>
            </div>
          </div>

          <div className="relative mt-9 min-h-0 flex-1">
            {aside ?? (
              <StepList labels={stepLabels} count={stepCount} current={stepNumber} />
            )}
          </div>

          {/* The panel is taller than the step list, and an empty half-panel
              looks like something failed to load. This is the one thing worth
              saying on every step. */}
          <p className="relative mt-6 max-w-[30ch] text-[12px] leading-relaxed text-text-muted">
            Nothing here leaves this computer unless you turn on syncing, and you can
            change any of these choices later in Settings.
          </p>
        </aside>

        {/* Content */}
        <div className="flex min-w-0 flex-1 flex-col px-11 pb-8 pt-11">{children}</div>
      </div>
    </div>
  );
}

/** Where you are in the walkthrough, as a readable list rather than as dots. */
function StepList({
  labels,
  count,
  current,
}: {
  labels?: string[];
  count: number;
  current: number;
}) {
  // Without labels there is nothing worth naming, so fall back to the dots the
  // frame used to draw at the foot of the content column.
  if (!labels || labels.length !== count) {
    return (
      <ol className="flex list-none items-center gap-[7px]" aria-label="Setup progress">
        {Array.from({ length: count }, (_, i) => (
          <li
            key={i}
            aria-current={i === current - 1 ? "step" : undefined}
            className={
              i === current - 1
                ? "h-[5px] w-[22px] rounded-full bg-accent"
                : i < current - 1
                  ? "h-[5px] w-[5px] rounded-full bg-accent/45"
                  : "h-[5px] w-[5px] rounded-full bg-border"
            }
          />
        ))}
      </ol>
    );
  }

  return (
    <ol className="list-none space-y-3.5" aria-label="Setup progress">
      {labels.map((label, i) => {
        const done = i < current - 1;
        const active = i === current - 1;
        return (
          <li
            key={label}
            aria-current={active ? "step" : undefined}
            className="flex items-center gap-3"
          >
            <span
              aria-hidden="true"
              className={
                active
                  ? "h-[9px] w-[9px] shrink-0 rounded-full bg-accent"
                  : done
                    ? "h-[9px] w-[9px] shrink-0 rounded-full bg-accent/40"
                    : "h-[9px] w-[9px] shrink-0 rounded-full border border-border"
              }
            />
            <span
              className={`text-[13px] leading-tight ${
                active
                  ? "font-semibold text-text-primary"
                  : done
                    ? "text-text-secondary"
                    : "text-text-muted"
              }`}
            >
              {label}
            </span>
          </li>
        );
      })}
    </ol>
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
