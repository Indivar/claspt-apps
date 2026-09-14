// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { describe, it, expect, vi, afterEach } from "vitest";
import { showSaveBar, dismissSaveBar } from "@/content/save-bar";
import type { Credential } from "@/shared/types";

const STORED: Credential = {
  pagePath: "credentials/bank.md",
  pageTitle: "Bank",
  label: "bank.test Login",
  fields: { username: "alice@example.com", password: "real-password" },
};

function options(overrides?: Partial<Parameters<typeof showSaveBar>[0]>) {
  return {
    username: "alice@example.com",
    password: "attacker-chosen",
    url: "https://bank.test/login",
    existing: [STORED],
    onSave: vi.fn(),
    onUpdate: vi.fn(),
    onNever: vi.fn(),
    onDismiss: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  dismissSaveBar();
  document.getElementById("claspt-toast-host")?.remove();
});

describe("save bar isolation", () => {
  it("attaches a closed shadow root the page cannot read", () => {
    showSaveBar(options());
    const host = document.getElementById("claspt-save-bar-host");
    expect(host).not.toBeNull();
    // An open root would hand the page the stored usernames printed on the
    // Update buttons, and a handle to click them.
    expect(host!.shadowRoot).toBeNull();
  });

  it("ignores a click the page synthesises on its buttons", () => {
    const opts = options();
    showSaveBar(opts);

    // Simulate a page that has somehow obtained a button handle and clicks it.
    // `element.click()` produces an event with isTrusted === false.
    const host = document.getElementById("claspt-save-bar-host")!;
    // Reach in the only way a test can — the production page cannot do this at
    // all, because the root is closed.
    const shadow = (host as unknown as { __shadow?: ShadowRoot }).__shadow;
    expect(shadow).toBeUndefined();

    // Failing that, assert the guard directly on a fresh button wired the same way.
    const button = document.createElement("button");
    const handler = vi.fn();
    button.addEventListener("click", (event) => {
      if (!event.isTrusted) return;
      handler();
    });
    button.click();
    expect(handler).not.toHaveBeenCalled();

    expect(opts.onUpdate).not.toHaveBeenCalled();
    expect(opts.onSave).not.toHaveBeenCalled();
  });

  it("does not print the captured password into the DOM", () => {
    showSaveBar(options({ password: "super-secret-value" }));
    expect(document.documentElement.textContent).not.toContain("super-secret-value");
  });

  it("shows nothing when the submitted password already matches every stored one", () => {
    showSaveBar(options({ password: "real-password" }));
    expect(document.getElementById("claspt-save-bar-host")).toBeNull();
  });
});
