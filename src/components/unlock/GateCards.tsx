// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * The specimen and one feature card at a time on the vault gate, so the
 * screen people see several times a day says something different each time.
 *
 * It is deliberately calm: a person is typing a master password next to
 * it. A card fades in, stays ten seconds, and the next takes its place. The
 * specimen above it belongs to the card: when the next card is about the
 * same scene only the lit lines move, when it is about another scene the
 * frame changes with the card. The rotation pauses while the pointer rests
 * on it, and with the system's reduced-motion setting on nothing changes by
 * itself. Arrows and a counter let anyone look through the cards at their
 * own pace.
 */
import { useEffect, useState } from "react";
import {
  CARD_INTERVAL_MS,
  cardAt,
  CARDS,
  nextIndex,
  prevIndex,
  SCENES,
  startIndex,
} from "@/lib/gate-cards";
import { GateSpecimen } from "@/components/unlock/GateSpecimen";

function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** How long the vault's secret stays readable before it seals itself, once. */
const SEAL_AFTER_MS = 1100;

const arrowClass =
  "rounded px-1.5 text-[14px] leading-none text-text-muted transition-colors hover:text-text-primary";

export function GateCards() {
  const count = CARDS.length;
  const [index, setIndex] = useState(() => startIndex(Date.now(), count));
  const [paused, setPaused] = useState(false);
  const [still] = useState(reducedMotion);
  const [sealed, setSealed] = useState(still);

  useEffect(() => {
    if (paused || still) return;
    const id = window.setInterval(
      () => setIndex((i) => nextIndex(i, count)),
      CARD_INTERVAL_MS,
    );
    return () => window.clearInterval(id);
  }, [paused, still, count]);

  useEffect(() => {
    if (sealed) return;
    const timer = window.setTimeout(() => setSealed(true), SEAL_AFTER_MS);
    return () => window.clearTimeout(timer);
    // Runs once: after the seal there is nothing left to schedule.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const card = cardAt(index);
  const scene = SCENES[card.scene];

  return (
    <section
      aria-label="What Claspt does"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {/* Keyed by scene, so the frame fades in fresh only when the scene
          changes; between cards of one scene the highlight moves instead. */}
      <div key={card.scene} className={still ? "" : "gate-card-in"}>
        <GateSpecimen scene={scene} highlight={card.highlight} sealed={sealed} />
      </div>

      {/* Keyed by index so each card fades in as a fresh element; a fixed
          minimum height keeps the form on the right from shifting. */}
      <div key={index} className={`mt-7 min-h-[96px] ${still ? "" : "gate-card-in"}`}>
        <p className="text-[11px] font-medium uppercase tracking-wider text-text-muted/70">
          {card.kicker}
          {card.pro ? " \u00b7 Pro" : ""}
        </p>
        <p className="mt-1 text-[13px] font-semibold text-text-primary">{card.title}</p>
        <p className="mt-0.5 max-w-[46ch] text-[12.5px] leading-relaxed text-text-muted">
          {card.body}
        </p>
      </div>
      <div className="mt-3 flex items-center gap-1">
        <button
          type="button"
          aria-label="Previous feature"
          onClick={() => setIndex((i) => prevIndex(i, count))}
          className={arrowClass}
        >
          ‹
        </button>
        <span className="min-w-[5ch] text-center font-mono text-[11px] text-text-muted/70">
          {index + 1} / {count}
        </span>
        <button
          type="button"
          aria-label="Next feature"
          onClick={() => setIndex((i) => nextIndex(i, count))}
          className={arrowClass}
        >
          ›
        </button>
      </div>
    </section>
  );
}
