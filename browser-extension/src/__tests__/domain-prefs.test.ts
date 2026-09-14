// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { describe, it, expect } from "vitest";
import { isExcludedDomain } from "@/shared/domain-prefs";

describe("isExcludedDomain", () => {
  it("matches the exact host", () => {
    expect(isExcludedDomain("bank.example", ["bank.example"])).toBe(true);
  });

  it("covers subdomains of an excluded site", () => {
    expect(isExcludedDomain("login.bank.example", ["bank.example"])).toBe(true);
  });

  it("does not match a look-alike suffix", () => {
    expect(isExcludedDomain("notbank.example", ["bank.example"])).toBe(false);
    expect(isExcludedDomain("bank.example.evil.com", ["bank.example"])).toBe(false);
  });

  it("is case-insensitive and tolerates stray whitespace", () => {
    expect(isExcludedDomain("BANK.example", ["  Bank.Example "])).toBe(true);
  });

  it("is false for an empty list or empty entries", () => {
    expect(isExcludedDomain("bank.example", [])).toBe(false);
    expect(isExcludedDomain("bank.example", ["", "   "])).toBe(false);
  });
});
