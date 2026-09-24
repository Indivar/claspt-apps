// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { describe, it, expect, vi } from "vitest";
import { hostIsIntact, guardHost, HOST_STYLE } from "@/content/picker-integrity";
import { buildRowMenu, lastUsedText, type RowMenuActions } from "@/content/picker-menu";

function host(): HTMLElement {
  const el = document.createElement("div");
  el.className = "claspt-inline-dropdown-host";
  el.setAttribute("style", HOST_STYLE);
  document.body.appendChild(el);
  return el;
}

describe("hostIsIntact", () => {
  it("trusts the host as created", () => {
    expect(hostIsIntact(host())).toBe(true);
  });

  it("refuses a host the page made transparent, moved, or hid", () => {
    for (const tamper of [
      "opacity: 0.01",
      "transform: translate(40px, 0)",
      "visibility: hidden",
      "display: none",
      "pointer-events: none",
    ]) {
      const el = host();
      el.style.cssText += ";" + tamper;
      expect(hostIsIntact(el), tamper).toBe(false);
    }
  });

  it("refuses a detached host", () => {
    const el = host();
    el.remove();
    expect(hostIsIntact(el)).toBe(false);
    expect(hostIsIntact(null)).toBe(false);
  });
});

describe("guardHost", () => {
  it("puts the style and class back after the page changes them", async () => {
    const el = host();
    const observer = guardHost(el, "claspt-inline-dropdown-host");
    el.setAttribute("style", "opacity: 0.01; position: absolute");
    el.className = "something-else";
    await new Promise((r) => setTimeout(r, 0));
    expect(el.getAttribute("style")).toBe(HOST_STYLE);
    expect(el.className).toBe("claspt-inline-dropdown-host");
    observer.disconnect();
  });
});

describe("buildRowMenu", () => {
  const actions = (over: Partial<RowMenuActions> = {}): RowMenuActions => ({
    pinned: false,
    primary: false,
    deprecated: false,
    hasUsername: true,
    hasPassword: true,
    hasTotp: false,
    onTogglePin: vi.fn(),
    onFill: vi.fn(),
    onFillSubmit: vi.fn(),
    onCopyUsername: vi.fn(),
    onCopyPassword: vi.fn(),
    onCopyTotp: vi.fn(),
    onTogglePrimary: vi.fn(),
    onToggleDeprecated: vi.fn(),
    onEdit: vi.fn(),
    ...over,
  });
  const labels = (entries: ReturnType<typeof buildRowMenu>) =>
    entries.map((e) => ("separator" in e ? "|" : e.label));

  it("groups actions and never offers what cannot work from a page", () => {
    expect(labels(buildRowMenu(actions()))).toEqual([
      "Pin to top",
      "|",
      "Fill form",
      "Fill & submit",
      "|",
      "Copy username",
      "Copy password",
      "|",
      "Mark as primary",
      "Mark as deprecated",
      "|",
      "Edit credential…",
    ]);
    const all = labels(buildRowMenu(actions())).join(" ");
    for (const dead of ["Rename", "Move to folder", "Delete"])
      expect(all).not.toContain(dead);
  });

  it("offers the two-factor code only when there is a seed, and every item has an icon", () => {
    const withTotp = buildRowMenu(actions({ hasTotp: true }));
    expect(labels(withTotp)).toContain("Copy 2FA code");
    for (const e of withTotp)
      if (!("separator" in e)) expect(e.icon, e.label).toBeTruthy();
  });

  it("drops an empty group without a stray separator", () => {
    const none = labels(
      buildRowMenu(actions({ hasUsername: false, hasPassword: false })),
    );
    expect(none.join(" ")).not.toMatch(/\| \|/);
    expect(none[0]).toBe("Pin to top");
  });

  it("reflects state in the labels", () => {
    const l = labels(
      buildRowMenu(actions({ pinned: true, primary: true, deprecated: true })),
    );
    expect(l).toContain("Unpin");
    expect(l).toContain("Unmark primary");
    expect(l).toContain("Restore (un-deprecate)");
  });
});

describe("lastUsedText", () => {
  it("reads like a person", () => {
    const now = 1_000_000_000_000;
    expect(lastUsedText(undefined, now)).toBeNull();
    expect(lastUsedText(now - 5_000, now)).toBe("used just now");
    expect(lastUsedText(now - 5 * 60_000, now)).toBe("used 5 min ago");
    expect(lastUsedText(now - 3 * 3_600_000, now)).toBe("used 3 h ago");
    expect(lastUsedText(now - 2 * 86_400_000, now)).toBe("used 2 d ago");
    expect(lastUsedText(now - 70 * 86_400_000, now)).toBe("used 2 mo ago");
  });
});
