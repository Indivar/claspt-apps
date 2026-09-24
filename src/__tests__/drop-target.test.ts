// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { describe, it, expect } from "vitest";
import { nextDropTarget, pointInside } from "@/lib/drop-target";

const rect = { left: 100, top: 50, right: 500, bottom: 350 };
const isImage = (path: string) => /\.(png|jpe?g|pdf)$/i.test(path);

describe("drop target", () => {
  it("knows inside from outside", () => {
    expect(pointInside(rect, 100, 50)).toBe(true);
    expect(pointInside(rect, 300, 200)).toBe(true);
    expect(pointInside(rect, 99, 200)).toBe(false);
    expect(pointInside(rect, 300, 351)).toBe(false);
  });

  it("lights up when an attachable file enters over the editor", () => {
    const state = nextDropTarget(
      { type: "enter", paths: ["/tmp/scan.PNG"], position: { x: 300, y: 200 } },
      false,
      rect,
      1,
      isImage,
    );
    expect(state).toEqual({ active: true, attachable: true });
  });

  it("stays dark for a file the editor would not attach", () => {
    const state = nextDropTarget(
      { type: "enter", paths: ["/tmp/setup.exe"], position: { x: 300, y: 200 } },
      false,
      rect,
      1,
      isImage,
    );
    expect(state).toEqual({ active: false, attachable: false });
  });

  it("follows the pointer in and out on over events, remembering what entered", () => {
    expect(
      nextDropTarget(
        { type: "over", position: { x: 300, y: 200 } },
        true,
        rect,
        1,
        isImage,
      ),
    ).toEqual({ active: true, attachable: true });
    expect(
      nextDropTarget(
        { type: "over", position: { x: 10, y: 10 } },
        true,
        rect,
        1,
        isImage,
      ),
    ).toEqual({ active: false, attachable: true });
    expect(
      nextDropTarget(
        { type: "over", position: { x: 300, y: 200 } },
        false,
        rect,
        1,
        isImage,
      ),
    ).toEqual({ active: false, attachable: false });
  });

  it("scales physical pixels to the layout before the check", () => {
    // 600,400 physical on a 2x display is 300,200 in layout: inside.
    expect(
      nextDropTarget(
        { type: "over", position: { x: 600, y: 400 } },
        true,
        rect,
        2,
        isImage,
      ).active,
    ).toBe(true);
    // The same numbers unscaled would be outside.
    expect(
      nextDropTarget(
        { type: "over", position: { x: 600, y: 400 } },
        true,
        rect,
        1,
        isImage,
      ).active,
    ).toBe(false);
  });

  it("goes dark on leave and on drop", () => {
    expect(nextDropTarget({ type: "leave" }, true, rect, 1, isImage)).toEqual({
      active: false,
      attachable: false,
    });
    expect(
      nextDropTarget(
        { type: "drop", paths: ["/tmp/a.png"], position: { x: 300, y: 200 } },
        true,
        rect,
        1,
        isImage,
      ),
    ).toEqual({ active: false, attachable: false });
  });
});
