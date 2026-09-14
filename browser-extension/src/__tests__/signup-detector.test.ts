// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { describe, it, expect, vi } from "vitest";
import { observeSignupForms } from "@/content/signup-detector";

/**
 * The capture path used to hand results back by dispatching a CustomEvent on
 * `document`. That is a node the page shares, so the page could read the event
 * — whose detail carried the user's cleartext password — and could forge one to
 * drive the save bar with values of its own choosing.
 */
describe("credential capture does not use the shared DOM", () => {
  it("never dispatches a claspt event on document", async () => {
    const seen: Event[] = [];
    const originalDispatch = document.dispatchEvent.bind(document);
    vi.spyOn(document, "dispatchEvent").mockImplementation((event: Event) => {
      seen.push(event);
      return originalDispatch(event);
    });

    document.body.innerHTML = `
      <form id="login">
        <input type="email" name="email" />
        <input type="password" name="password" />
        <button type="submit">Sign in</button>
      </form>`;
    const form = document.getElementById("login") as HTMLFormElement;
    (form.querySelector('input[type="email"]') as HTMLInputElement).value = "me@example.com";
    (form.querySelector('input[type="password"]') as HTMLInputElement).value = "hunter2";

    const onCapture = vi.fn();
    observeSignupForms(onCapture);
    form.dispatchEvent(new Event("submit", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));

    expect(onCapture).toHaveBeenCalledTimes(1);
    expect(onCapture.mock.calls[0][0]).toMatchObject({
      username: "me@example.com",
      password: "hunter2",
    });

    const clasptEvents = seen.filter((e) => e.type.startsWith("claspt"));
    expect(clasptEvents).toEqual([]);
  });

  it("a page listening for the old event name learns nothing", async () => {
    const eavesdropper = vi.fn();
    document.addEventListener("claspt-async-capture", eavesdropper);

    document.body.innerHTML = `
      <form id="login2">
        <input type="password" name="password" />
        <button type="submit">Sign in</button>
      </form>`;
    const form = document.getElementById("login2") as HTMLFormElement;
    (form.querySelector('input[type="password"]') as HTMLInputElement).value = "hunter2";

    observeSignupForms(vi.fn());
    form.dispatchEvent(new Event("submit", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));

    expect(eavesdropper).not.toHaveBeenCalled();
    document.removeEventListener("claspt-async-capture", eavesdropper);
  });
});
