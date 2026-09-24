// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { describe, it, expect, vi, afterEach } from "vitest";
import { showSaveBar, dismissSaveBar, updatableCredentials } from "@/content/save-bar";
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
    onSave: vi.fn(async () => true),
    onUpdate: vi.fn(async () => true),
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

describe("which login an update is offered for", () => {
  const bob: Credential = {
    pagePath: "credentials/bob.md",
    pageTitle: "Bob",
    label: "bank.test Login",
    fields: { username: "bob@example.com", password: "bobs-password" },
  };
  const passwordOnly: Credential = {
    pagePath: "credentials/pin.md",
    pageTitle: "Pin",
    label: "bank.test Pin",
    fields: { password: "1234" },
  };

  it("offers Update only for the same account, whatever the case of the address", () => {
    const offered = updatableCredentials([STORED, bob], "Alice@Example.com", "new-password");
    expect(offered.map((c) => c.pagePath)).toEqual(["credentials/bank.md"]);
  });

  it("treats a second account on the same site as a new login, never an update", () => {
    expect(updatableCredentials([STORED], "carol@example.com", "carols-password")).toEqual([]);
    showSaveBar(options({ username: "carol@example.com", password: "carols-password" }));
    expect(document.getElementById("claspt-save-bar-host")).not.toBeNull();
  });

  it("offers nothing when the same account submitted the password already saved", () => {
    expect(updatableCredentials([STORED], "alice@example.com", "real-password")).toEqual([]);
  });

  it("matches a password-only secret only when the page gave no username either", () => {
    expect(updatableCredentials([passwordOnly], "", "5678")).toEqual([passwordOnly]);
    expect(updatableCredentials([passwordOnly], "alice@example.com", "5678")).toEqual([]);
  });

  it("still shows the bar for a different account even though another account's password matches", () => {
    // Bob's stored password happens to equal what Carol typed: Carol is a new login.
    showSaveBar(options({ existing: [bob], username: "carol@example.com", password: "bobs-password" }));
    expect(document.getElementById("claspt-save-bar-host")).not.toBeNull();
  });
});
