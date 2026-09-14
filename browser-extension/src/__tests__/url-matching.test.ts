// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { describe, it, expect } from "vitest";
import {
  getRegistrableDomain,
  isAutofillSafe,
  isDomainMismatch,
  scoreCredentialMatch,
  domainMatches,
} from "@/shared/url-matching";
import { PUBLIC_SUFFIX_LIST_DATE } from "@/shared/public-suffix-data";

describe("getRegistrableDomain", () => {
  it("reduces ordinary hostnames to eTLD+1", () => {
    expect(getRegistrableDomain("login.github.com")).toBe("github.com");
    expect(getRegistrableDomain("github.com")).toBe("github.com");
    expect(getRegistrableDomain("a.b.c.example.com")).toBe("example.com");
  });

  it("handles multi-label ccTLD suffixes", () => {
    expect(getRegistrableDomain("app.example.co.uk")).toBe("example.co.uk");
    expect(getRegistrableDomain("insurance.ami.co.nz")).toBe("ami.co.nz");
    expect(getRegistrableDomain("shop.brand.com.au")).toBe("brand.com.au");
  });

  it("is case- and trailing-dot-insensitive", () => {
    expect(getRegistrableDomain("LOGIN.GitHub.COM")).toBe("github.com");
    expect(getRegistrableDomain("github.com.")).toBe("github.com");
  });

  it("returns IP addresses unchanged", () => {
    expect(getRegistrableDomain("192.168.1.1")).toBe("192.168.1.1");
    expect(getRegistrableDomain("[::1]")).toBe("[::1]");
  });

  it("treats an unlisted TLD as the PSL `*` rule", () => {
    expect(getRegistrableDomain("shop.brand.invalidtld")).toBe("brand.invalidtld");
  });

  it("honours PSL wildcard and exception rules", () => {
    // `*.ck` is a public suffix, `!www.ck` is the exception.
    expect(getRegistrableDomain("a.b.ck")).toBe("a.b.ck");
    expect(getRegistrableDomain("www.ck")).toBe("www.ck");
  });

  it("never collapses a hostname that is itself a public suffix", () => {
    // No registrable domain exists, so the whole host is kept rather than
    // being shortened onto a name it would share with unrelated sites.
    expect(getRegistrableDomain("github.io")).toBe("github.io");
    expect(getRegistrableDomain("co.uk")).toBe("co.uk");
  });

  it("ships a dated list", () => {
    expect(PUBLIC_SUFFIX_LIST_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

/**
 * Regression tests for the shared-hosting auto-fill leak.
 *
 * The hand-curated suffix table these replaced knew about `co.uk` but not about
 * private registries, so `victim.github.io` and `attacker.github.io` both
 * reduced to `github.io` and counted as the same site. Anyone who can claim a
 * free subdomain on one of these hosts could then receive the password.
 */
describe("shared-hosting isolation", () => {
  const SHARED_HOSTS = [
    "github.io",
    "vercel.app",
    "pages.dev",
    "workers.dev",
    "netlify.app",
    "herokuapp.com",
    "web.app",
    "firebaseapp.com",
    "azurewebsites.net",
    "blogspot.com",
    "s3.amazonaws.com",
  ];

  for (const host of SHARED_HOSTS) {
    it(`keeps two subdomains of ${host} apart`, () => {
      const victim = `victim.${host}`;
      const attacker = `attacker.${host}`;

      expect(getRegistrableDomain(victim)).not.toBe(getRegistrableDomain(attacker));
      expect(domainMatches(`https://${victim}`, `https://${attacker}`)).toBe(false);

      const credential = { url: `https://${victim}/login` };
      expect(isAutofillSafe(`https://${attacker}/login`, credential)).toBe(false);
      expect(isDomainMismatch(credential.url, attacker)).toBe(true);

      // And the legitimate site still works.
      expect(isAutofillSafe(`https://${victim}/login`, credential)).toBe(true);
      expect(isDomainMismatch(credential.url, victim)).toBe(false);
    });
  }
});

describe("isAutofillSafe", () => {
  it("requires a stored URL — a label match is never enough", () => {
    expect(isAutofillSafe("https://github.com", { url: undefined })).toBe(false);
  });

  it("allows subdomains of the same registrable domain by default", () => {
    expect(isAutofillSafe("https://accounts.google.com/x", { url: "https://google.com" })).toBe(true);
  });

  it("refuses a different registrable domain", () => {
    expect(isAutofillSafe("https://github-login.evil.com", { url: "https://github.com" })).toBe(false);
  });

  it("respects the `host` mode", () => {
    const cred = { url: "https://accounts.google.com" };
    expect(isAutofillSafe("https://accounts.google.com", cred, "host")).toBe(true);
    expect(isAutofillSafe("https://mail.google.com", cred, "host")).toBe(false);
  });

  it("respects the `exact` mode", () => {
    const cred = { url: "https://example.com/login" };
    expect(isAutofillSafe("https://example.com/login", cred, "exact")).toBe(true);
    expect(isAutofillSafe("https://example.com/other", cred, "exact")).toBe(false);
  });

  it("respects `never`", () => {
    expect(isAutofillSafe("https://example.com", { url: "https://example.com" }, "never")).toBe(false);
  });
});

describe("isDomainMismatch", () => {
  it("is false when the credential has no saved URL", () => {
    expect(isDomainMismatch(undefined, "example.com")).toBe(false);
  });

  it("allows legitimate subdomains", () => {
    expect(isDomainMismatch("https://google.com", "accounts.google.com")).toBe(false);
  });

  it("flags a look-alike domain", () => {
    expect(isDomainMismatch("https://github.com", "github-login.evil.com")).toBe(true);
  });
});

describe("scoreCredentialMatch", () => {
  const base = { label: "GitHub", pageTitle: "GitHub Login" };

  it("scores a URL-backed domain match at 100", () => {
    expect(scoreCredentialMatch("https://github.com/login", { ...base, url: "https://github.com" })).toBe(100);
  });

  it("scores zero for an unrelated site", () => {
    expect(scoreCredentialMatch("https://example.com", { ...base, url: "https://github.com" })).toBe(0);
  });

  it("returns zero for `never`", () => {
    expect(scoreCredentialMatch("https://github.com", { ...base, url: "https://github.com" }, "never")).toBe(0);
  });

  it("does not reach the auto-fill threshold on a label-only match", () => {
    const score = scoreCredentialMatch("https://github.com", { label: "github - me", pageTitle: "" });
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(100);
  });
});
