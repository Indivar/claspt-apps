// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { StepHeading, StepFooter } from "@/components/setup/WizardFrame";
import { USE_CASES, type UseCaseId } from "@/components/setup/use-cases";
import { usePagesStore } from "@/stores/pages-store";

/** The help page the walkthrough sends people to, matched on its title. */
const FIRST_STOP = "AI Integration";

export function DoneStep({
  chosen,
  onFinish,
}: {
  chosen: UseCaseId[];
  onFinish: (startTour: boolean) => void;
}) {
  // Finish first, then open the page: the walkthrough sits over the app, so
  // opening underneath it and leaving it up would look like nothing happened.
  const finishAndOpenGuide = async () => {
    onFinish(false);
    const store = usePagesStore.getState();
    if (store.pages.length === 0) await store.loadPages();
    const page = usePagesStore
      .getState()
      .pages.find((p) => p.meta.title.includes(FIRST_STOP));
    if (page) await usePagesStore.getState().openPage(page.path);
  };

  return (
    <>
      <StepHeading eyebrow="All set" title="You are ready to go">
        Here is what is now set up. Anything you skipped can be added later in Settings,
        and you can run this walkthrough again from there.
      </StepHeading>

      <ul className="mb-5 flex list-none flex-col gap-1.5">
        {USE_CASES.map((uc) => {
          const on = chosen.includes(uc.id);
          return (
            <li
              key={uc.id}
              className={`flex items-center gap-3 text-[13.5px] ${on ? "text-text-secondary" : "text-text-muted"}`}
            >
              <span
                aria-hidden="true"
                className={`inline-block h-2 w-2 shrink-0 rounded-full ${on ? "bg-success" : "bg-border"}`}
              />
              <span>
                <strong className="font-semibold text-text-primary">{uc.title}</strong>
                {on ? "" : " — not set up"}
              </span>
            </li>
          );
        })}
      </ul>

      {/* What the app looks like, said before they see it.
          Finishing used to drop people straight into an editor showing raw
          markdown, with no indication that the formatted version was one click
          away. Someone who has not written markdown before reads that as the
          product being harder than it is. */}
      <div className="mb-5 rounded-xl border border-border/60 bg-surface-raised/60 px-4 py-3.5">
        <p className="mb-1.5 text-[13px] font-semibold text-text-primary">
          What your vault looks like
        </p>
        <p className="max-w-[52ch] text-[12.5px] leading-relaxed text-text-secondary">
          Pages are written in markdown and open side by side: what you type on the left,
          how it reads on the right. The buttons above the page switch between writing,
          reading, and both. Your help folder has fifteen short pages covering the rest.
        </p>
      </div>

      <div className="border-t border-border/50 pt-4">
        <p className="mb-2.5 text-[13.5px] text-text-secondary">
          A good first stop is the AI integration guide, or take the short tour.
        </p>
        <div className="flex flex-wrap gap-2.5">
          <button
            type="button"
            onClick={() => void finishAndOpenGuide()}
            className="rounded-xl border border-border/60 bg-surface px-4 py-2.5 text-[13px] font-medium text-text-secondary transition-colors hover:bg-surface-overlay/60"
          >
            Open the AI integration guide
          </button>
          {/* The tour is offered, never forced. It used to start on its own,
              which put a full-screen overlay in front of someone who had not
              yet done the thing they came to do. */}
          <button
            type="button"
            onClick={() => onFinish(true)}
            className="rounded-xl border border-border/60 bg-surface px-4 py-2.5 text-[13px] font-medium text-text-secondary transition-colors hover:bg-surface-overlay/60"
          >
            Show me around (2 minutes)
          </button>
        </div>
      </div>

      <StepFooter>
        <button
          type="button"
          onClick={() => onFinish(false)}
          className="btn-accent rounded-xl px-8 py-3 text-[13px]"
        >
          Start using Claspt
        </button>
      </StepFooter>
    </>
  );
}
