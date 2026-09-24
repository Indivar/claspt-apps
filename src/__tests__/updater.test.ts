// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));

import { reduceProgress, NO_PROGRESS } from "@/lib/updater";
import type { DownloadEvent } from "@tauri-apps/plugin-updater";

describe("reduceProgress", () => {
  it("reports a percentage once the size is known and caps it at 100", () => {
    let p = reduceProgress(NO_PROGRESS, {
      event: "Started",
      data: { contentLength: 1000 },
    } as DownloadEvent);
    expect(p.percent).toBe(0);
    p = reduceProgress(p, {
      event: "Progress",
      data: { chunkLength: 250 },
    } as DownloadEvent);
    expect(p.percent).toBe(25);
    p = reduceProgress(p, {
      event: "Progress",
      data: { chunkLength: 900 },
    } as DownloadEvent);
    expect(p.percent).toBe(100);
    p = reduceProgress(p, {
      event: "Finished",
      data: undefined,
    } as unknown as DownloadEvent);
    expect(p.finished).toBe(true);
  });

  it("stays indeterminate when the server sends no length", () => {
    let p = reduceProgress(NO_PROGRESS, { event: "Started", data: {} } as DownloadEvent);
    expect(p.percent).toBeNull();
    p = reduceProgress(p, {
      event: "Progress",
      data: { chunkLength: 10 },
    } as DownloadEvent);
    expect(p.percent).toBeNull();
    expect(p.downloaded).toBe(10);
  });
});
