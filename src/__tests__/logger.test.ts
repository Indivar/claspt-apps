// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createLogger, setLogLevel, getLogLevel } from "@/lib/logger";

describe("logger", () => {
  beforeEach(() => {
    setLogLevel("debug");
    vi.restoreAllMocks();
  });

  it("creates a logger with all four levels", () => {
    const log = createLogger("test");
    expect(log.debug).toBeTypeOf("function");
    expect(log.info).toBeTypeOf("function");
    expect(log.warn).toBeTypeOf("function");
    expect(log.error).toBeTypeOf("function");
  });

  it("logs at debug level when minLevel is debug", () => {
    const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const log = createLogger("test-mod");
    log.debug("hello");
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]![0]).toContain("[DEBUG]");
    expect(spy.mock.calls[0]![0]).toContain("[test-mod]");
    expect(spy.mock.calls[0]![0]).toContain("hello");
  });

  it("suppresses debug messages when minLevel is info", () => {
    setLogLevel("info");
    const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const log = createLogger("test");
    log.debug("should not appear");
    expect(spy).not.toHaveBeenCalled();
  });

  it("allows warn through when minLevel is warn", () => {
    setLogLevel("warn");
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const log = createLogger("test");
    log.debug("no");
    log.info("no");
    log.warn("yes");
    log.error("yes");

    expect(debugSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledOnce();
  });

  it("getLogLevel returns current level", () => {
    expect(getLogLevel()).toBe("debug");
    setLogLevel("error");
    expect(getLogLevel()).toBe("error");
  });

  it("passes extra args to console methods", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    const log = createLogger("test");
    log.info("msg", { extra: true }, 42);
    // args: [formatted string, color, { extra: true }, 42]
    expect(spy.mock.calls[0]!.length).toBeGreaterThanOrEqual(3);
  });
});
