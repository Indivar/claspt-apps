// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * The picker's host element lives in the page's light DOM, where the page's
 * own CSS and scripts can reach it. A closed shadow root stops the page
 * reading or synthesising clicks inside, but the host itself can be made
 * transparent, moved or resized so that a real click meant for a page button
 * lands on "Fill" instead. Two defences: the host's style is reasserted the
 * moment the page touches it, and every action checks the host still looks
 * like itself before acting.
 */

/** The exact inline style the host is created with. */
export const HOST_STYLE =
  "all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647;";

/**
 * Whether the host is attached and unaltered enough to trust a click on it.
 * Computed values are always populated in a browser; the empty-string cases
 * exist for test environments that only report declared values.
 */
export function hostIsIntact(host: Element | null): boolean {
  if (!host || !host.isConnected) return false;
  const cs = getComputedStyle(host);
  const opacityOk = cs.opacity === "" || cs.opacity === "1";
  const transformOk = cs.transform === "" || cs.transform === "none";
  const visible = cs.visibility !== "hidden" && cs.display !== "none";
  const clickable = cs.pointerEvents !== "none";
  const unfiltered = !cs.filter || cs.filter === "none";
  const unclipped = !cs.clipPath || cs.clipPath === "none";
  return opacityOk && transformOk && visible && clickable && unfiltered && unclipped;
}

/**
 * Put the host's style and class back whenever the page changes them.
 * Returns the observer so the caller can disconnect it with the dropdown.
 */
export function guardHost(host: HTMLElement, className: string): MutationObserver {
  const restore = () => {
    if (host.getAttribute("style") !== HOST_STYLE) host.setAttribute("style", HOST_STYLE);
    if (host.className !== className) host.className = className;
  };
  const observer = new MutationObserver(restore);
  observer.observe(host, { attributes: true, attributeFilter: ["style", "class"] });
  return observer;
}
