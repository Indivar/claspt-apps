// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { describe, it, expect, vi } from "vitest";
import {
  clearPendingSave,
  getLastCapture,
  getPendingSave,
  getStepUsername,
  parkPendingSave,
  senderSite,
  setLastCapture,
  setPendingSave,
  setStepUsername,
} from "@/background/session-store";
import { stores } from "./setup";

/** A content script on `url`, in the top frame. */
function page(url: string): chrome.runtime.MessageSender {
  return { url, frameId: 0, tab: { id: 1, url } as chrome.tabs.Tab };
}

const POPUP: chrome.runtime.MessageSender = {
  url: "chrome-extension://test-extension-id/src/popup/index.html",
};

const CAPTURE = { username: "me", password: "pw", url: "https://shop.test/login", isSignup: false };

describe("senderSite", () => {
  it("is the registrable domain of a top-frame page, and nothing else", () => {
    expect(senderSite(page("https://accounts.shop.test/x"))).toBe("shop.test");
    expect(senderSite(POPUP)).toBeNull();
    expect(
      senderSite({ url: "https://shop.test/", frameId: 3, tab: { id: 1 } as chrome.tabs.Tab }),
    ).toBeNull();
  });
});

describe("pending save", () => {
  it("is offered again on the same site and on no other", async () => {
    expect(await setPendingSave(page("https://shop.test/login"), CAPTURE)).toBe(true);
    // A redirect to another host of the same site still sees it.
    const same = await getPendingSave(page("https://account.shop.test/home"));
    expect(same).toMatchObject({ username: "me", password: "pw", domain: "shop.test" });
    // The next site the user opens does not.
    expect(await getPendingSave(page("https://other.test/"))).toBeNull();
    expect(await getPendingSave(POPUP)).toBeNull();
  });

  it("takes the site from the sender, so a page cannot file a capture under another site", async () => {
    await setPendingSave(page("https://evil.test/"), { ...CAPTURE, url: "https://bank.test/login" });
    expect(await getPendingSave(page("https://bank.test/"))).toBeNull();
    expect(await getPendingSave(page("https://evil.test/"))).toMatchObject({ domain: "evil.test" });
  });

  it("is refused from anything that is not a page", async () => {
    expect(await setPendingSave(POPUP, CAPTURE)).toBe(false);
    expect(stores.session.has("claspt_pending_save")).toBe(false);
  });

  it("can only be cleared or parked by its own site", async () => {
    await setPendingSave(page("https://shop.test/"), CAPTURE);
    await clearPendingSave(page("https://other.test/"));
    expect(stores.session.has("claspt_pending_save")).toBe(true);
    await parkPendingSave(page("https://other.test/"));
    expect(stores.session.has("claspt_pending_save")).toBe(true);

    // Parking only ends the bar's handoff: the capture itself is in the vault.
    await parkPendingSave(page("https://shop.test/"));
    expect(stores.session.has("claspt_pending_save")).toBe(false);
    expect([...stores.session.keys()]).toEqual([]);
  });

  it("keeps offering a capture for an hour, then stops without keeping a copy", async () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000_000);
    await setPendingSave(page("https://shop.test/"), { ...CAPTURE, pagePath: "credentials/me.md" });
    now.mockReturnValue(1_000_000 + 3_500_000);
    expect((await getPendingSave(page("https://shop.test/")))?.pagePath).toBe("credentials/me.md");
    now.mockReturnValue(1_000_000 + 3_600_001);
    expect(await getPendingSave(page("https://shop.test/"))).toBeNull();
    expect([...stores.session.keys()]).toEqual([]);
    now.mockRestore();
  });
});

describe("last capture outcome", () => {
  it("is filed under the sender's site and read back by site", async () => {
    await setLastCapture(page("https://accounts.shop.test/login"), {
      outcome: "captured",
      username: "me",
      pagePath: "credentials/me.md",
    });
    await setLastCapture(page("https://other.test/"), { outcome: "excluded", username: "" });

    expect((await getLastCapture("shop.test"))?.outcome).toBe("captured");
    expect((await getLastCapture("shop.test"))?.username).toBe("me");
    expect((await getLastCapture("other.test"))?.outcome).toBe("excluded");
    expect(await getLastCapture("nowhere.test")).toBeNull();
  });

  it("keeps one record per site, the newest, and none from a non-page sender", async () => {
    await setLastCapture(page("https://shop.test/"), { outcome: "failed", username: "a" });
    await setLastCapture(page("https://shop.test/"), { outcome: "captured", username: "b" });
    await setLastCapture(POPUP, { outcome: "captured", username: "c" });

    const record = await getLastCapture("shop.test");
    expect(record?.outcome).toBe("captured");
    expect(record?.username).toBe("b");
    const all = stores.session.get("claspt_last_capture") as unknown[];
    expect(all).toHaveLength(1);
  });
});

describe("step-one username", () => {
  it("is returned to the same host only, and forgotten after three minutes", async () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(5_000);
    expect(await setStepUsername(page("https://login.example/step1"), "me@example.com")).toBe(true);
    expect(await getStepUsername(page("https://login.example/step2"))).toBe("me@example.com");
    expect(await getStepUsername(page("https://other.example/step2"))).toBeNull();
    expect(await getStepUsername(POPUP)).toBeNull();
    now.mockReturnValue(5_000 + 179_000);
    expect(await getStepUsername(page("https://login.example/step2"))).toBe("me@example.com");
    now.mockReturnValue(5_000 + 180_001);
    expect(await getStepUsername(page("https://login.example/step2"))).toBeNull();
    now.mockRestore();
  });

  it("is refused from a non-page sender and for an empty value", async () => {
    expect(await setStepUsername(POPUP, "me")).toBe(false);
    expect(await setStepUsername(page("https://login.example/"), "")).toBe(false);
  });
});
