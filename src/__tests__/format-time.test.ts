// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { describe, it, expect, vi, afterEach } from "vitest";
import { formatTimeAgo } from "@claspt/shared/format-time";

describe("formatTimeAgo", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "just now" for dates less than 1 minute ago', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:30Z"));
    expect(formatTimeAgo("2026-01-15T12:00:00Z")).toBe("just now");
  });

  it("returns minutes ago for dates < 1 hour", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:05:00Z"));
    expect(formatTimeAgo("2026-01-15T12:00:00Z")).toBe("5m ago");
  });

  it("returns hours ago for dates < 24 hours", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T15:00:00Z"));
    expect(formatTimeAgo("2026-01-15T12:00:00Z")).toBe("3h ago");
  });

  it("returns days ago for dates < 7 days", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-17T12:00:00Z"));
    expect(formatTimeAgo("2026-01-15T12:00:00Z")).toBe("2d ago");
  });

  it("returns locale date string for dates >= 7 days", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-25T12:00:00Z"));
    const result = formatTimeAgo("2026-01-15T12:00:00Z");
    // Should be a locale date string, not relative
    expect(result).not.toContain("ago");
    expect(result).not.toBe("just now");
  });

  it("handles exactly 1 minute boundary", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:01:00Z"));
    expect(formatTimeAgo("2026-01-15T12:00:00Z")).toBe("1m ago");
  });

  it("handles exactly 1 hour boundary", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T13:00:00Z"));
    expect(formatTimeAgo("2026-01-15T12:00:00Z")).toBe("1h ago");
  });

  it("handles exactly 1 day boundary", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-16T12:00:00Z"));
    expect(formatTimeAgo("2026-01-15T12:00:00Z")).toBe("1d ago");
  });
});
