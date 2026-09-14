// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { describe, it, expect, vi, beforeEach } from "vitest";

describe("platform", () => {
  const originalNavigator = globalThis.navigator;

  beforeEach(() => {
    vi.resetModules();
  });

  it("detects macOS and sets modKey to Cmd", async () => {
    Object.defineProperty(globalThis, "navigator", {
      value: { platform: "MacIntel" },
      writable: true,
      configurable: true,
    });
    const { isMac, modKey, kbd } = await import("@/lib/platform");
    expect(isMac).toBe(true);
    expect(modKey).toBe("Cmd");
    expect(kbd("Mod+S")).toBe("Cmd+S");
    Object.defineProperty(globalThis, "navigator", {
      value: originalNavigator,
      writable: true,
      configurable: true,
    });
  });

  it("detects non-macOS and sets modKey to Ctrl", async () => {
    Object.defineProperty(globalThis, "navigator", {
      value: { platform: "Linux x86_64" },
      writable: true,
      configurable: true,
    });
    const { isMac, modKey, kbd } = await import("@/lib/platform");
    expect(isMac).toBe(false);
    expect(modKey).toBe("Ctrl");
    expect(kbd("Mod+S")).toBe("Ctrl+S");
    Object.defineProperty(globalThis, "navigator", {
      value: originalNavigator,
      writable: true,
      configurable: true,
    });
  });

  it("replaces multiple Mod occurrences in kbd()", async () => {
    Object.defineProperty(globalThis, "navigator", {
      value: { platform: "MacIntel" },
      writable: true,
      configurable: true,
    });
    const { kbd } = await import("@/lib/platform");
    expect(kbd("Mod+Shift+Mod+K")).toBe("Cmd+Shift+Cmd+K");
    Object.defineProperty(globalThis, "navigator", {
      value: originalNavigator,
      writable: true,
      configurable: true,
    });
  });
});
