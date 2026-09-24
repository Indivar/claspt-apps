// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://shop.example.com/login" }

/**
 * What reaches a form field. The seed of a two-factor credential must never be
 * one of those things: a page that shows a "verification code" box receives
 * the current six digits or nothing, and the seed stays in the vault.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DetectedField } from "@/content/form-detector";
import type { Credential } from "@/shared/types";

// The arithmetic is tested against RFC 6238 elsewhere; here only the routing
// matters, and jsdom's Web Crypto cannot run it anyway.
vi.mock("@claspt/shared/totp", () => ({
  generateTotp: vi.fn((seed: string) =>
    seed === "BAD"
      ? Promise.reject(new Error("bad seed"))
      : Promise.resolve({ code: "123456", remaining: 20, period: 30 }),
  ),
}));

import { fillFields } from "@/content/form-filler";

const SEED = "JBSWY3DPEHPK3PXP";

function form() {
  document.body.innerHTML = `
    <form>
      <input id="u" type="text" name="username">
      <input id="p" type="password" name="password">
      <input id="o" type="text" name="otp" autocomplete="one-time-code">
    </form>`;
  const u = document.getElementById("u") as HTMLInputElement;
  const p = document.getElementById("p") as HTMLInputElement;
  const o = document.getElementById("o") as HTMLInputElement;
  const fields: DetectedField[] = [
    { element: u, type: "username" } as DetectedField,
    { element: p, type: "password" } as DetectedField,
    { element: o, type: "otp" } as DetectedField,
  ];
  return { u, p, o, fields };
}

const credential = (totp: string): Credential => ({
  pagePath: "credentials/shop.md",
  pageTitle: "Shop",
  label: "Shop",
  url: "https://shop.example.com",
  fields: { username: "me", password: "pw", totp },
});

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("two-factor fields", () => {
  it("never receive the seed, on the synchronous path or after it", async () => {
    const { o, fields } = form();
    fillFields(fields, credential(SEED), { showFlash: false, autoFillTotp: true });
    expect(o.value).not.toBe(SEED);
    await new Promise((r) => setTimeout(r, 0));
    expect(o.value).toBe("123456");
    expect(o.value).not.toContain(SEED);
  });

  it("stay empty when auto-fill of codes is off", async () => {
    const { o, u, p, fields } = form();
    fillFields(fields, credential(SEED), { showFlash: false, autoFillTotp: false });
    await new Promise((r) => setTimeout(r, 0));
    expect(u.value).toBe("me");
    expect(p.value).toBe("pw");
    expect(o.value).toBe("");
  });

  it("stay empty when the seed will not decode", async () => {
    const { o, fields } = form();
    fillFields(fields, credential("BAD"), { showFlash: false, autoFillTotp: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(o.value).toBe("");
  });

  it("do not count as a fill on their own", () => {
    const { fields } = form();
    const onlyOtp = fields.filter((f) => f.type === "otp");
    expect(
      fillFields(onlyOtp, credential(SEED), { showFlash: false, autoFillTotp: true }),
    ).toBe(false);
  });
});
