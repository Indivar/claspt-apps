// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { describe, expect, it } from "vitest";
import { isDesktopTooOld, MIN_DESKTOP_VERSION } from "@/shared/desktop-version";

describe("isDesktopTooOld", () => {
  it("refuses a desktop from before the pairing handshake", () => {
    expect(isDesktopTooOld("3.0.6")).toBe(true);
    expect(isDesktopTooOld("3.10.9")).toBe(true);
    expect(isDesktopTooOld("2.0.3")).toBe(true);
  });

  it("accepts the minimum and everything after it, comparing numbers not text", () => {
    expect(isDesktopTooOld(MIN_DESKTOP_VERSION)).toBe(false);
    expect(isDesktopTooOld("4.0.39")).toBe(false);
    expect(isDesktopTooOld("4.1.0")).toBe(false);
    expect(isDesktopTooOld("4.10.0")).toBe(false);
    expect(isDesktopTooOld("10.0.0")).toBe(false);
    expect(isDesktopTooOld("4.1.0-beta.1")).toBe(false);
  });

  it("does not guess when the version is unknown or unreadable", () => {
    expect(isDesktopTooOld(undefined)).toBe(false);
    expect(isDesktopTooOld("")).toBe(false);
    expect(isDesktopTooOld("nightly")).toBe(false);
  });
});
