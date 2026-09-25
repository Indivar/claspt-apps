// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { describe, expect, it } from "vitest";
import {
  biometricUnlockOffered,
  shouldAutoPromptBiometric,
  type AutoPromptInput,
} from "@/lib/biometric-prompt";

/** A cold start in "primary" mode with the window in front: the one case that prompts. */
const coldStart: AutoPromptInput = {
  lockReason: null,
  biometricAvailable: true,
  biometricMode: "primary",
  biometricFailures: 0,
  loading: false,
  hasUnlockedWithPassword: false,
  windowFocused: true,
  pageVisible: true,
};

describe("shouldAutoPromptBiometric", () => {
  it("prompts on a cold start with the window in front", () => {
    expect(shouldAutoPromptBiometric(coldStart)).toBe(true);
    expect(shouldAutoPromptBiometric({ ...coldStart, biometricMode: "enabled" })).toBe(
      true,
    );
  });

  it("never prompts after the idle lock, the key lock, or a manual lock", () => {
    // The bug: a lock every fifteen minutes became a Touch ID dialog every
    // fifteen minutes, on top of whatever else the person was doing.
    expect(shouldAutoPromptBiometric({ ...coldStart, lockReason: "auto" })).toBe(false);
    expect(shouldAutoPromptBiometric({ ...coldStart, lockReason: "key" })).toBe(false);
    expect(shouldAutoPromptBiometric({ ...coldStart, lockReason: "manual" })).toBe(false);
  });

  it("does not prompt while the window is behind other work or hidden", () => {
    expect(shouldAutoPromptBiometric({ ...coldStart, windowFocused: false })).toBe(false);
    expect(shouldAutoPromptBiometric({ ...coldStart, pageVisible: false })).toBe(false);
  });

  it("stops after three failures, while busy, and when biometrics are off", () => {
    expect(shouldAutoPromptBiometric({ ...coldStart, biometricFailures: 3 })).toBe(false);
    expect(shouldAutoPromptBiometric({ ...coldStart, biometricFailures: 2 })).toBe(true);
    expect(shouldAutoPromptBiometric({ ...coldStart, loading: true })).toBe(false);
    expect(shouldAutoPromptBiometric({ ...coldStart, biometricAvailable: false })).toBe(
      false,
    );
    expect(shouldAutoPromptBiometric({ ...coldStart, biometricMode: "disabled" })).toBe(
      false,
    );
  });

  it("in reauth mode prompts only once a password has been entered this session", () => {
    expect(shouldAutoPromptBiometric({ ...coldStart, biometricMode: "reauth" })).toBe(
      false,
    );
    expect(
      shouldAutoPromptBiometric({
        ...coldStart,
        biometricMode: "reauth",
        hasUnlockedWithPassword: true,
      }),
    ).toBe(true);
  });
});

describe("biometricUnlockOffered", () => {
  it("offers the button in enabled and primary modes, and in reauth after a password", () => {
    expect(biometricUnlockOffered("enabled", false)).toBe(true);
    expect(biometricUnlockOffered("primary", false)).toBe(true);
    expect(biometricUnlockOffered("reauth", false)).toBe(false);
    expect(biometricUnlockOffered("reauth", true)).toBe(true);
    expect(biometricUnlockOffered("disabled", true)).toBe(false);
  });
});
