// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { useCallback, useEffect, useRef, useState } from "react";

type Placement = "top" | "right" | "bottom" | "left";

interface Position {
  top: number;
  left: number;
  actualPlacement: Placement;
}

const MARGIN = 16;
const TOOLTIP_WIDTH = 280;
const TOOLTIP_HEIGHT_ESTIMATE = 180;

export function useTooltipPosition(
  targetSelector: string | null,
  preferredPlacement: Placement,
  active: boolean,
) {
  const [position, setPosition] = useState<Position | null>(null);
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  const mutationObserverRef = useRef<MutationObserver | null>(null);

  const calculate = useCallback(() => {
    if (!targetSelector || !active) {
      setPosition(null);
      setTargetRect(null);
      return false;
    }

    const el = document.querySelector(targetSelector);
    if (!el) {
      setPosition(null);
      setTargetRect(null);
      return false;
    }

    const rect = el.getBoundingClientRect();
    setTargetRect(rect);

    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const placements: Placement[] = [
      preferredPlacement,
      "right",
      "bottom",
      "left",
      "top",
    ];

    // Try to find a placement that fits entirely within the viewport
    for (const p of placements) {
      const pos = calcPosition(rect, p);
      if (fitsInViewport(pos, vw, vh)) {
        setPosition({ ...pos, actualPlacement: p });
        return true;
      }
    }

    // No placement fits — clamp the preferred placement to viewport bounds.
    // This handles large targets (e.g. the editor) where the tooltip must
    // overlap the target to remain visible.
    const pos = calcPosition(rect, preferredPlacement);
    setPosition({
      top: clamp(pos.top, MARGIN, vh - TOOLTIP_HEIGHT_ESTIMATE - MARGIN),
      left: clamp(pos.left, MARGIN, vw - TOOLTIP_WIDTH - MARGIN),
      actualPlacement: preferredPlacement,
    });
    return true;
  }, [targetSelector, preferredPlacement, active]);

  useEffect(() => {
    // Measures the target element via getBoundingClientRect and stores the
    // resulting position — a post-mount DOM measurement that cannot be derived
    // during render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    const found = calculate();

    window.addEventListener("resize", calculate);
    const resizeObserver = new ResizeObserver(calculate);
    resizeObserver.observe(document.body);

    // If the target element wasn't found, watch the DOM for it to appear.
    // This handles steps where prepare() opens a page/panel asynchronously.
    if (!found && active && targetSelector) {
      mutationObserverRef.current = new MutationObserver(() => {
        if (document.querySelector(targetSelector)) {
          calculate();
          mutationObserverRef.current?.disconnect();
          mutationObserverRef.current = null;
        }
      });
      mutationObserverRef.current.observe(document.body, {
        childList: true,
        subtree: true,
      });
    }

    return () => {
      window.removeEventListener("resize", calculate);
      resizeObserver.disconnect();
      mutationObserverRef.current?.disconnect();
      mutationObserverRef.current = null;
    };
  }, [calculate, active, targetSelector]);

  return { position, targetRect };
}

function calcPosition(
  rect: DOMRect,
  placement: Placement,
): { top: number; left: number } {
  switch (placement) {
    case "right":
      return {
        top: rect.top + rect.height / 2 - TOOLTIP_HEIGHT_ESTIMATE / 2,
        left: rect.right + MARGIN,
      };
    case "left":
      return {
        top: rect.top + rect.height / 2 - TOOLTIP_HEIGHT_ESTIMATE / 2,
        left: rect.left - TOOLTIP_WIDTH - MARGIN,
      };
    case "bottom":
      return {
        top: rect.bottom + MARGIN,
        left: rect.left + rect.width / 2 - TOOLTIP_WIDTH / 2,
      };
    case "top":
      return {
        top: rect.top - TOOLTIP_HEIGHT_ESTIMATE - MARGIN,
        left: rect.left + rect.width / 2 - TOOLTIP_WIDTH / 2,
      };
  }
}

function fitsInViewport(
  pos: { top: number; left: number },
  vw: number,
  vh: number,
): boolean {
  return (
    pos.top >= MARGIN &&
    pos.top + TOOLTIP_HEIGHT_ESTIMATE <= vh - MARGIN &&
    pos.left >= MARGIN &&
    pos.left + TOOLTIP_WIDTH <= vw - MARGIN
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
