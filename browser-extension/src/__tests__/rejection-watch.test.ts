// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { rejectionShown, watchForRejection } from "@/content/rejection-watch";

function loginForm(): HTMLFormElement {
  const form = document.createElement("form");
  const user = document.createElement("input");
  user.type = "email";
  const password = document.createElement("input");
  password.type = "password";
  form.append(user, password);
  document.body.appendChild(form);
  return form;
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe("what counts as a rejected login", () => {
  it("is nothing while the page merely still shows the form", () => {
    loginForm();
    expect(rejectionShown()).toBe(false);
  });

  it("is the password field marked invalid", () => {
    const form = loginForm();
    form.querySelector('input[type="password"]')!.setAttribute("aria-invalid", "true");
    expect(rejectionShown()).toBe(true);
  });

  it("is an alert that names the problem, but not any alert", () => {
    loginForm();
    const alert = document.createElement("div");
    alert.setAttribute("role", "alert");
    alert.textContent = "Signing you in";
    document.body.appendChild(alert);
    expect(rejectionShown()).toBe(false);

    alert.textContent = "The password you entered is incorrect.";
    expect(rejectionShown()).toBe(true);
  });

  it("ignores an alert the page keeps hidden", () => {
    loginForm();
    const alert = document.createElement("div");
    alert.setAttribute("role", "alert");
    alert.hidden = true;
    alert.textContent = "Wrong password";
    document.body.appendChild(alert);
    expect(rejectionShown()).toBe(false);
  });

  it("is nothing once the password field is gone: the site moved on", () => {
    const alert = document.createElement("div");
    alert.setAttribute("role", "alert");
    alert.textContent = "Wrong password";
    document.body.appendChild(alert);
    expect(rejectionShown()).toBe(false);
  });
});

describe("watching after submit", () => {
  it("reports a rejection that appears within the window, once", async () => {
    vi.useFakeTimers();
    const form = loginForm();
    const onRejected = vi.fn();
    watchForRejection(onRejected, { href: () => "https://a.test/login" });

    form.querySelector('input[type="password"]')!.setAttribute("aria-invalid", "true");
    await vi.runAllTimersAsync();
    form.querySelector('input[type="password"]')!.setAttribute("aria-invalid", "false");
    form.querySelector('input[type="password"]')!.setAttribute("aria-invalid", "true");
    await vi.runAllTimersAsync();

    expect(onRejected).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("stops quietly when the page navigates away or the window ends", async () => {
    vi.useFakeTimers();
    const form = loginForm();
    const onRejected = vi.fn();
    let href = "https://a.test/login";
    watchForRejection(onRejected, { href: () => href, windowMs: 1000 });

    href = "https://a.test/home";
    form.querySelector('input[type="password"]')!.setAttribute("aria-invalid", "true");
    await vi.runAllTimersAsync();
    expect(onRejected).not.toHaveBeenCalled();

    const late = vi.fn();
    watchForRejection(late, { href: () => "https://b.test/", windowMs: 1000 });
    await vi.advanceTimersByTimeAsync(1001);
    loginForm()
      .querySelector('input[type="password"]')!
      .setAttribute("aria-invalid", "true");
    await vi.runAllTimersAsync();
    expect(late).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
