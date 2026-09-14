// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import React, { useEffect, useLayoutEffect } from "react";

export interface ContextAction {
  id: string;
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  destructive?: boolean;
  divider?: boolean; // show a separator BEFORE this item
  disabled?: boolean;
}

interface Props {
  x: number;
  y: number;
  actions: ContextAction[];
  onClose: () => void;
}

/**
 * Floating context menu, positioned at viewport coordinates. Closes on:
 *   - click outside
 *   - Escape key
 *   - selecting any item
 *   - scrolling the popup body
 */
export function RowContextMenu({ x, y, actions, onClose }: Props) {
  const menuRef = React.useRef<HTMLDivElement>(null);

  // Cheap pre-paint clamp: a rough estimate keeps the menu close to the click
  // even before we measure. useLayoutEffect below corrects this synchronously
  // before paint using the real measured height — that's the authoritative pass.
  const ESTIMATED_WIDTH = 200;
  const ESTIMATED_ITEM_H = 30;
  const dividerCount = actions.filter((a) => a.divider).length;
  const estimatedHeight = actions.length * ESTIMATED_ITEM_H + dividerCount * 9 + 16;
  const vw = typeof window !== "undefined" ? window.innerWidth : 400;
  const vh = typeof window !== "undefined" ? window.innerHeight : 600;
  const clampedLeft = Math.min(Math.max(4, x), Math.max(4, vw - ESTIMATED_WIDTH - 4));
  const clampedTop = Math.min(Math.max(4, y), Math.max(4, vh - estimatedHeight - 4));

  // After mount, measure the real menu height and reposition by mutating the
  // DOM node directly. Direct style mutation (no setState) keeps the project's
  // "no setState in useEffect" lint rule happy; useLayoutEffect runs before
  // paint so there's no visible jump from the estimated position.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const winH = window.innerHeight;
    const winW = window.innerWidth;
    const margin = 4;
    let nextTop = y;
    let nextLeft = x;
    if (nextTop + rect.height > winH - margin) {
      nextTop = Math.max(margin, winH - rect.height - margin);
    }
    if (nextLeft + rect.width > winW - margin) {
      nextLeft = Math.max(margin, winW - rect.width - margin);
    }
    el.style.top = `${nextTop}px`;
    el.style.left = `${nextLeft}px`;
  }, [x, y, actions.length]);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    function onScroll(e: Event) {
      // Don't close on scroll inside the menu itself — the menu is internally
      // scrollable as a safety net for very tall menus.
      if (menuRef.current?.contains(e.target as Node)) return;
      onClose();
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [onClose]);

  // maxHeight + overflowY are the safety net: if the menu is genuinely taller
  // than the popup viewport (rare but possible with all optional items present),
  // the menu becomes internally scrollable rather than getting clipped.
  const style: React.CSSProperties = {
    left: clampedLeft,
    top: clampedTop,
    maxHeight: "calc(100vh - 8px)",
    overflowY: "auto",
  };

  return (
    <div
      ref={menuRef}
      role="menu"
      className="fixed z-50 min-w-[180px] rounded-md border border-border bg-surface shadow-lg py-1 text-[12px]"
      style={style}
    >
      {actions.map((a) => (
        <React.Fragment key={a.id}>
          {a.divider && <div className="my-1 border-t border-border" />}
          <button
            type="button"
            role="menuitem"
            disabled={a.disabled}
            onClick={(e) => {
              e.stopPropagation();
              if (!a.disabled) {
                a.onClick();
                onClose();
              }
            }}
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors ${
              a.disabled
                ? "text-text-dim cursor-not-allowed"
                : a.destructive
                  ? "text-red-500 hover:bg-red-500/10"
                  : "text-text-secondary hover:bg-surface-raised hover:text-text-primary"
            }`}
          >
            {a.icon && <span className="w-3.5 h-3.5 shrink-0">{a.icon}</span>}
            <span className="flex-1">{a.label}</span>
          </button>
        </React.Fragment>
      ))}
    </div>
  );
}
