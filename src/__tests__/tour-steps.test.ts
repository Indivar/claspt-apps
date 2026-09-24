// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { describe, it, expect } from "vitest";
import {
  TOUR_STEPS,
  CURRENT_TOUR_VERSION,
  getQuickSteps,
  getAdvancedSteps,
  getNewSteps,
} from "@/components/tour/tour-steps";

describe("tour-steps", () => {
  it("getQuickSteps returns only quick tier", () => {
    const steps = getQuickSteps();
    expect(steps.length).toBe(6);
    expect(steps.every((s) => s.tier === "quick")).toBe(true);
  });

  it("getAdvancedSteps returns only advanced tier", () => {
    const steps = getAdvancedSteps();
    expect(steps.length).toBe(9);
    expect(steps.every((s) => s.tier === "advanced")).toBe(true);
  });

  it("all steps have unique IDs", () => {
    const ids = TOUR_STEPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("all steps target a data-tour selector", () => {
    for (const step of TOUR_STEPS) {
      expect(step.target).toMatch(/^\[data-tour="[^"]+"\]$/);
    }
  });

  it("getNewSteps filters by version", () => {
    expect(getNewSteps(0).length).toBe(TOUR_STEPS.length);
    expect(getNewSteps(1).length).toBe(0);
    expect(getNewSteps(CURRENT_TOUR_VERSION).length).toBe(0);
  });
});

describe("tour steps and the plan", () => {
  it("leaves Pro-only steps out for a free user", () => {
    // A tour is a promise that what it points at is there. The sharing step
    // walked a free user through a feature they cannot use and pointed at a
    // control they may not have.
    const free = getAdvancedSteps(false);
    const pro = getAdvancedSteps(true);
    expect(free.length).toBeLessThan(pro.length);
    expect(free.some((s) => s.id === "sharing")).toBe(false);
    expect(pro.some((s) => s.id === "sharing")).toBe(true);
  });

  it("keeps every step that needs no licence", () => {
    const free = getQuickSteps(false);
    expect(free.length).toBe(getQuickSteps(true).length);
    expect(free.every((s) => !s.pro)).toBe(true);
  });

  it("never points a step at a control the plan does not include", () => {
    // The guard that matters: any step marked pro must be filtered out, not
    // merely the one we happened to name above.
    for (const step of [...getQuickSteps(false), ...getAdvancedSteps(false)]) {
      expect(step.pro, `${step.id} is Pro-only but shown to a free user`).toBeFalsy();
    }
  });
});
