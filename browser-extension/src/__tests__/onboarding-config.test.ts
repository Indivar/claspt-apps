// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { describe, it, expect } from "vitest";
import { onboardingConfig } from "@/shared/onboarding-config";
import { DEFAULT_CONFIG } from "@/shared/types";

describe("what the onboarding writes", () => {
  it("keeps the token pairing stored when the token box was left empty", () => {
    const stored = {
      ...DEFAULT_CONFIG,
      token: "clss_paired",
      excludedDomains: ["bank.test"],
    };

    const config = onboardingConfig(stored, 9315, "", true);

    expect(config.token).toBe("clss_paired");
    expect(config.onboardingComplete).toBe(true);
    // Nothing else stored is lost on the way through the wizard.
    expect(config.excludedDomains).toEqual(["bank.test"]);
  });

  it("lets a typed token replace the stored one, trimmed", () => {
    const stored = { ...DEFAULT_CONFIG, token: "clss_paired" };
    expect(onboardingConfig(stored, 9315, "  clss_typed ", false).token).toBe(
      "clss_typed",
    );
    expect(onboardingConfig(stored, 9315, "   ", false).token).toBe("clss_paired");
  });

  it("starts from the defaults on a fresh install and takes the port", () => {
    const config = onboardingConfig(undefined, 9400, "", true);
    expect(config.port).toBe(9400);
    expect(config.token).toBe("");
    expect(config.autoLockMinutes).toBe(DEFAULT_CONFIG.autoLockMinutes);
  });

  it("never turns a completed onboarding back into an incomplete one", () => {
    const stored = { ...DEFAULT_CONFIG, onboardingComplete: true };
    expect(onboardingConfig(stored, 9315, "clss_x", false).onboardingComplete).toBe(true);
  });
});
