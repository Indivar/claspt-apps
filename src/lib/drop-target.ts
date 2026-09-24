// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Whether a file being dragged over the window should light the editor up
 * as a drop target, so the person knows the drop will be taken.
 *
 * Tauri reports a native drag as `enter` (with the file paths), `over`
 * (position only), `leave` and `drop`. Only `enter` says what is being
 * dragged, so the caller keeps that answer and passes it back for the
 * `over` events. Positions arrive in physical pixels.
 */
export interface DragEventLike {
  type: "enter" | "over" | "drop" | "leave";
  paths?: string[];
  position?: { x: number; y: number };
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface DropTarget {
  /** Show the drop frame. */
  active: boolean;
  /** Whether the drag holds at least one file the editor would attach. */
  attachable: boolean;
}

export function pointInside(rect: Rect, x: number, y: number): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

export function nextDropTarget(
  event: DragEventLike,
  known: boolean,
  rect: Rect,
  scale: number,
  isAttachable: (path: string) => boolean,
): DropTarget {
  const factor = scale > 0 ? scale : 1;
  const inside = event.position
    ? pointInside(rect, event.position.x / factor, event.position.y / factor)
    : false;
  switch (event.type) {
    case "enter": {
      const attachable = (event.paths ?? []).some(isAttachable);
      return { active: attachable && inside, attachable };
    }
    case "over":
      return { active: known && inside, attachable: known };
    case "drop":
    case "leave":
      return { active: false, attachable: false };
  }
}
