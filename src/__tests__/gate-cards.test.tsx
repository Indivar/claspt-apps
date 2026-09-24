// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { GateCards } from "@/components/unlock/GateCards";
import {
  CARD_INTERVAL_MS,
  cardAt,
  CARDS,
  nextIndex,
  prevIndex,
  SCENES,
  SPECIMEN_PLAINTEXT,
  startIndex,
} from "@/lib/gate-cards";

function pretendReducedMotion(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

/** The card on screen, from the counter the component shows. */
function shownIndex(): number {
  const counter = screen.getByText(/^\d+ \/ \d+$/).textContent ?? "";
  return Number(counter.split(" / ")[0]) - 1;
}

describe("gate cards", () => {
  it("has enough real cards, each short and distinct", () => {
    expect(CARDS.length).toBeGreaterThanOrEqual(10);
    const titles = new Set(CARDS.map((c) => c.title));
    expect(titles.size).toBe(CARDS.length);
    for (const card of CARDS) {
      expect(card.kicker.length).toBeGreaterThan(0);
      expect(card.body.length).toBeLessThanOrEqual(160);
      // The brief's rule: source-available, never "open source".
      expect(card.body.toLowerCase()).not.toContain("open source");
      expect(card.title.toLowerCase()).not.toContain("open source");
    }
  });

  it("gives every card a scene and lines that exist, and every scene a card", () => {
    const used = new Set<string>();
    for (const card of CARDS) {
      const scene = SCENES[card.scene];
      expect(scene, card.title).toBeDefined();
      used.add(card.scene);
      expect(card.highlight.length, card.title).toBeGreaterThan(0);
      const keys = new Set(scene.lines.map((l) => l.key));
      for (const key of card.highlight) {
        expect(keys.has(key), `${card.title} points at ${key}`).toBe(true);
      }
    }
    for (const scene of Object.values(SCENES)) {
      expect(used.has(scene.id), `${scene.id} has no card`).toBe(true);
      // The frame has a fixed height and width; a scene must fit it without
      // wrapping, or the lit line spills and the picture muddles.
      expect(scene.lines.length).toBeLessThanOrEqual(10);
      for (const line of scene.lines) {
        const width = line.text.length + (line.accent?.length ?? 0);
        expect(width, `${scene.id}: ${line.key}`).toBeLessThanOrEqual(52);
      }
      const keys = scene.lines.map((l) => l.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it("shows no value that could pass for a real secret", () => {
    for (const scene of Object.values(SCENES)) {
      for (const line of scene.lines) {
        const text = `${line.text} ${line.accent ?? ""}`;
        // The one access key on the gate is the documented AWS example.
        expect(text.replace(SPECIMEN_PLAINTEXT, "")).not.toMatch(/AKIA[0-9A-Z]{16}/);
        expect(text).not.toMatch(/enc:v1:/);
      }
    }
  });

  it("starts somewhere in range, the same place for the same seed, and steps around", () => {
    const n = CARDS.length;
    expect(startIndex(1_700_000_000_000, n)).toBe(startIndex(1_700_000_000_000, n));
    expect(startIndex(1_700_000_000_000, n)).toBeLessThan(n);
    expect(startIndex(-7, n)).toBeGreaterThanOrEqual(0);
    expect(nextIndex(n - 1, n)).toBe(0);
    expect(prevIndex(0, n)).toBe(n - 1);
    expect(nextIndex(3, n)).toBe(4);
    expect(startIndex(5, 0)).toBe(0);
  });
});

describe("GateCards", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    pretendReducedMotion(false);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows one card and moves to the next after the interval", () => {
    render(<GateCards />);
    const first = shownIndex();
    expect(screen.getByText(cardAt(first).title)).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(CARD_INTERVAL_MS);
    });

    expect(shownIndex()).toBe(nextIndex(first, CARDS.length));
  });

  it("pauses while the pointer rests on it", () => {
    render(<GateCards />);
    const first = shownIndex();
    const region = screen.getByRole("region", { name: "What Claspt does" });

    fireEvent.mouseEnter(region);
    act(() => {
      vi.advanceTimersByTime(CARD_INTERVAL_MS * 2);
    });
    expect(shownIndex()).toBe(first);

    fireEvent.mouseLeave(region);
    act(() => {
      vi.advanceTimersByTime(CARD_INTERVAL_MS);
    });
    expect(shownIndex()).toBe(nextIndex(first, CARDS.length));
  });

  it("steps with the arrows, which are glyphs and not escape text", () => {
    render(<GateCards />);
    const first = shownIndex();
    expect(screen.getByRole("button", { name: "Previous feature" }).textContent).toBe(
      "\u2039",
    );
    expect(screen.getByRole("button", { name: "Next feature" }).textContent).toBe(
      "\u203a",
    );
    expect(document.body.textContent).not.toContain("\\u");

    fireEvent.click(screen.getByRole("button", { name: "Next feature" }));
    expect(shownIndex()).toBe(nextIndex(first, CARDS.length));

    fireEvent.click(screen.getByRole("button", { name: "Previous feature" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous feature" }));
    expect(shownIndex()).toBe(prevIndex(first, CARDS.length));
  });

  it("does not change by itself when the system asks for reduced motion", () => {
    pretendReducedMotion(true);
    render(<GateCards />);
    const first = shownIndex();

    act(() => {
      vi.advanceTimersByTime(CARD_INTERVAL_MS * 3);
    });

    expect(shownIndex()).toBe(first);
    fireEvent.click(screen.getByRole("button", { name: "Next feature" }));
    expect(shownIndex()).toBe(nextIndex(first, CARDS.length));
  });
});

describe("the specimen follows the card", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    pretendReducedMotion(false);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  /** The line elements of the specimen, by key, with their highlight state. */
  function lines(): Map<string, "hi" | "dim" | ""> {
    const out = new Map<string, "hi" | "dim" | "">();
    for (const el of document.querySelectorAll<HTMLElement>("[data-line]")) {
      const state = el.classList.contains("specimen-hi")
        ? "hi"
        : el.classList.contains("specimen-dim")
          ? "dim"
          : "";
      out.set(el.dataset["line"] ?? "", state);
    }
    return out;
  }

  it("lights exactly the lines the card names, and changes the scene with the card", () => {
    render(<GateCards />);
    for (let step = 0; step < CARDS.length; step++) {
      const card = cardAt(shownIndex());
      const scene = SCENES[card.scene];
      expect(screen.getByText(scene.header)).toBeInTheDocument();
      const state = lines();
      for (const line of scene.lines) {
        const expected = card.highlight.includes(line.key) ? "hi" : "dim";
        expect(state.get(line.key), `${card.title}: ${line.key}`).toBe(expected);
      }
      fireEvent.click(screen.getByRole("button", { name: "Next feature" }));
    }
  });

  it("seals the vault's secret once, and keeps it sealed across cards", () => {
    render(<GateCards />);
    // Walk to the encryption card, whichever card the gate started on.
    while (cardAt(shownIndex()).title !== "Only the secrets are encrypted") {
      fireEvent.click(screen.getByRole("button", { name: "Next feature" }));
    }
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(document.body.textContent).not.toContain(SPECIMEN_PLAINTEXT);
    expect(document.body.textContent).toContain("enc:v1:");
  });
});
