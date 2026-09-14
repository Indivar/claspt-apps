// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { describe, it, expect } from "vitest";
import {
  generatePassword,
  generatePassphrase,
  generateMemorable,
  generatePin,
  generateUuid,
  estimateStrength,
} from "@/shared/generator";

const SYMBOLS = "!@#$%^&*()-_=+[]{}|;:,.<>?/~";
const countSymbols = (value: string) => [...value].filter((c) => SYMBOLS.includes(c)).length;

const BASE = {
  length: 24,
  uppercase: true,
  lowercase: true,
  digits: true,
  symbols: true,
};

describe("generatePassword", () => {
  it("honours the requested length", () => {
    for (const length of [4, 12, 24, 64, 128]) {
      expect(generatePassword({ ...BASE, length }).length).toBe(length);
    }
  });

  it("draws from every enabled category and none of the disabled ones", () => {
    const value = generatePassword({ ...BASE, length: 64, symbols: false, digits: false });
    expect(/[A-Z]/.test(value)).toBe(true);
    expect(/[a-z]/.test(value)).toBe(true);
    expect(/[0-9]/.test(value)).toBe(false);
    expect(countSymbols(value)).toBe(0);
  });

  it("caps symbols when asked", () => {
    // A 64-character draw from a charset that is roughly a third symbols lands
    // well above two without the cap, so this would fail if it were ignored.
    for (let i = 0; i < 25; i++) {
      const value = generatePassword({ ...BASE, length: 64, maxSymbols: 2 });
      expect(countSymbols(value)).toBeLessThanOrEqual(2);
      expect(value.length).toBe(64);
    }
  });

  it("removes every symbol at a cap of zero", () => {
    expect(countSymbols(generatePassword({ ...BASE, length: 40, maxSymbols: 0 }))).toBe(0);
  });

  it("exceeds two symbols without a cap, so the cap is what changes it", () => {
    const sawMany = Array.from({ length: 25 }, () =>
      countSymbols(generatePassword({ ...BASE, length: 64 })),
    ).some((n) => n > 2);
    expect(sawMany).toBe(true);
  });

  it("excludes ambiguous characters on request", () => {
    const value = generatePassword({ ...BASE, length: 100, excludeAmbiguous: true });
    for (const c of "0O1lI") expect(value).not.toContain(c);
  });

  it("never repeats a value across calls", () => {
    const seen = new Set(Array.from({ length: 50 }, () => generatePassword(BASE)));
    expect(seen.size).toBe(50);
  });
});

describe("generatePassphrase", () => {
  it("produces the requested number of words", () => {
    const value = generatePassphrase({
      wordCount: 5,
      separator: "-",
      capitalize: false,
      includeNumber: false,
    });
    expect(value.split("-")).toHaveLength(5);
  });

  it("capitalises and can add a number", () => {
    const value = generatePassphrase({
      wordCount: 4,
      separator: "-",
      capitalize: true,
      includeNumber: true,
    });
    expect(value).toMatch(/^[A-Z]/);
    expect(/\d/.test(value)).toBe(true);
  });

  it("honours a custom separator", () => {
    const value = generatePassphrase({
      wordCount: 3,
      separator: ".",
      capitalize: false,
      includeNumber: false,
    });
    expect(value.split(".")).toHaveLength(3);
    expect(value).not.toContain("-");
  });
});

describe("generateMemorable", () => {
  it("produces a pronounceable value", () => {
    const value = generateMemorable({ style: "pronounceable", syllableCount: 4, wordCount: 3 });
    expect(value.length).toBeGreaterThan(0);
    expect(value).toMatch(/^[a-z-]+$/);
  });

  it("produces a pattern value with words, digits and a symbol", () => {
    const value = generateMemorable({ style: "pattern", syllableCount: 4, wordCount: 3 });
    expect(/[A-Z]/.test(value)).toBe(true);
    expect(/\d/.test(value)).toBe(true);
  });
});

describe("generatePin", () => {
  it("produces digits only, at the requested length", () => {
    for (const length of [4, 6, 8, 12]) {
      const value = generatePin(length);
      expect(value).toMatch(/^\d+$/);
      expect(value.length).toBe(length);
    }
  });
});

describe("generateUuid", () => {
  it("produces a well-formed version 4 UUID", () => {
    for (let i = 0; i < 20; i++) {
      expect(generateUuid()).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });
});

describe("estimateStrength", () => {
  it("rates a long mixed password above a short one", () => {
    const weak = estimateStrength("abc");
    const strong = estimateStrength(generatePassword({ ...BASE, length: 32 }));
    expect(strong.score).toBeGreaterThan(weak.score);
    expect(strong.entropy).toBeGreaterThan(weak.entropy);
  });

  it("returns the shape the UI reads", () => {
    const result = estimateStrength("Correct-Horse-Battery-Staple-42");
    expect(typeof result.score).toBe("number");
    expect(typeof result.label).toBe("string");
    expect(typeof result.entropy).toBe("number");
    expect(typeof result.crackTime).toBe("string");
  });
});
