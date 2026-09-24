// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Remembering which identity was used on which site.
 *
 * The thing worth holding down is what is stored: a page path and nothing
 * else. If a name, an address or a phone number ever reached this store, it
 * would be sitting in browser storage in the clear, outside the vault.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  identityForSite,
  rememberIdentityForSite,
  clearIdentityPrefs,
} from "@/shared/identity-prefs";

beforeEach(async () => {
  await clearIdentityPrefs();
});

describe("identityForSite", () => {
  it("has no opinion about a site never seen before", async () => {
    expect(await identityForSite("shop.example")).toBeNull();
  });

  it("remembers the identity used on a site", async () => {
    await rememberIdentityForSite("shop.example", "identities/home.md");
    expect(await identityForSite("shop.example")).toBe("identities/home.md");
  });

  it("keeps sites apart", async () => {
    await rememberIdentityForSite("shop.example", "identities/home.md");
    await rememberIdentityForSite("work.example", "identities/work.md");
    expect(await identityForSite("shop.example")).toBe("identities/home.md");
    expect(await identityForSite("work.example")).toBe("identities/work.md");
  });

  it("takes the most recent choice for a site", async () => {
    await rememberIdentityForSite("shop.example", "identities/home.md");
    await rememberIdentityForSite("shop.example", "identities/work.md");
    expect(await identityForSite("shop.example")).toBe("identities/work.md");
  });

  it("stores the page path and nothing else", async () => {
    await rememberIdentityForSite("shop.example", "identities/home.md");
    const dump = JSON.stringify(await chrome.storage.local.get(null));
    expect(dump).toContain("identities/home.md");
    // Nothing resembling a value should ever have been passed in, and the
    // shape of the store makes it impossible to hold one.
    expect(dump).not.toMatch(/street|postcode|phone|@/i);
  });

  it("does not grow without limit", async () => {
    for (let i = 0; i < 260; i++) {
      await rememberIdentityForSite(`site-${i}.example`, "identities/home.md");
    }
    const map = (await chrome.storage.local.get("claspt:identity-for-site"))[
      "claspt:identity-for-site"
    ] as Record<string, string>;
    expect(Object.keys(map).length).toBeLessThanOrEqual(200);
    // The oldest are the ones dropped; the newest survive.
    expect(await identityForSite("site-259.example")).toBe("identities/home.md");
    expect(await identityForSite("site-0.example")).toBeNull();
  });

  it("ignores an empty host or path rather than storing a blank key", async () => {
    await rememberIdentityForSite("", "identities/home.md");
    await rememberIdentityForSite("shop.example", "");
    expect(await identityForSite("")).toBeNull();
    expect(await identityForSite("shop.example")).toBeNull();
  });
});
