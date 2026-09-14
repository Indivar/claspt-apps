// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { describe, it, expect, afterEach } from "vitest";
import {
  showUnverifiedSiteWarning,
  showPhishingWarning,
  showInsecureOriginWarning,
} from "@/content/warnings";

function host(id: string) {
  return document.getElementById(id);
}

afterEach(() => {
  for (const id of ["claspt-unverified-warning", "claspt-phishing-warning", "claspt-insecure-warning"]) {
    host(id)?.remove();
  }
});

describe("warning banners", () => {
  it("use a closed shadow root the page cannot read", () => {
    showPhishingWarning("github.com", "github-login.evil.com");
    const el = host("claspt-phishing-warning");
    expect(el).not.toBeNull();
    expect(el!.shadowRoot).toBeNull();
  });

  it("replace rather than stack on repeated refusals", () => {
    showPhishingWarning("a.com", "evil.com");
    showPhishingWarning("b.com", "evil.com");
    expect(document.querySelectorAll("#claspt-phishing-warning")).toHaveLength(1);
  });

  it("show an insecure-origin refusal", () => {
    showInsecureOriginWarning("example.com");
    expect(host("claspt-insecure-warning")).not.toBeNull();
  });
});

/**
 * A credential with no saved web address cannot be checked against the site it
 * is filled on, which is how a look-alike domain gets one offered to it. The
 * fill is allowed, so the user is told instead — but only once per credential
 * per page, because a banner on every fill is a banner nobody reads.
 */
describe("unverified-site advisory", () => {
  it("appears on the first fill of an address-less credential", () => {
    showUnverifiedSiteWarning("Google", "google.com.co");
    expect(host("claspt-unverified-warning")).not.toBeNull();
  });

  it("does not appear a second time for the same credential", () => {
    showUnverifiedSiteWarning("Repeat Me", "example.com");
    host("claspt-unverified-warning")!.remove();

    showUnverifiedSiteWarning("Repeat Me", "example.com");
    expect(host("claspt-unverified-warning")).toBeNull();
  });

  it("still appears for a different credential", () => {
    showUnverifiedSiteWarning("First", "example.com");
    host("claspt-unverified-warning")!.remove();

    showUnverifiedSiteWarning("Second", "example.com");
    expect(host("claspt-unverified-warning")).not.toBeNull();
  });
});
