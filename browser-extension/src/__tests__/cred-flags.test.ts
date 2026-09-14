// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { describe, it, expect } from "vitest";
import { labelShowsUsername, isPrimary, isDeprecated, statusBucket } from "@/shared/cred-flags";
import type { Credential } from "@/shared/types";

function cred(fields: Record<string, string>): Credential {
  return { pagePath: "p.md", pageTitle: "t", label: "l", fields };
}

describe("labelShowsUsername", () => {
  it("is true when the label already ends in the address", () => {
    expect(labelShowsUsername("google - alice@example.com", "alice@example.com")).toBe(true);
  });

  it("ignores case", () => {
    expect(labelShowsUsername("Google - Alice@Example.com", "alice@example.com")).toBe(true);
  });

  it("is false when the label is just the site name", () => {
    expect(labelShowsUsername("google.com Login", "alice@example.com")).toBe(false);
  });

  it("is false when there is no username", () => {
    expect(labelShowsUsername("google.com Login", "")).toBe(false);
  });
});

describe("credential flags", () => {
  it("reads the truthy spellings", () => {
    for (const v of ["true", "yes", "1", "y", "TRUE"]) {
      expect(isPrimary(cred({ primary: v }))).toBe(true);
    }
    expect(isPrimary(cred({ primary: "no" }))).toBe(false);
    expect(isPrimary(cred({}))).toBe(false);
  });

  it("treats legacy as deprecated", () => {
    expect(isDeprecated(cred({ legacy: "true" }))).toBe(true);
    expect(isDeprecated(cred({ deprecated: "true" }))).toBe(true);
  });

  it("sorts primary above normal above deprecated", () => {
    expect(statusBucket(cred({ primary: "true" }))).toBeLessThan(statusBucket(cred({})));
    expect(statusBucket(cred({}))).toBeLessThan(statusBucket(cred({ deprecated: "true" })));
  });
});
