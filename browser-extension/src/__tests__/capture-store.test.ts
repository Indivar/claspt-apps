// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * A captured login lives in the vault from the moment it is submitted. These
 * tests pin how it is written, found, confirmed, discarded and held while the
 * desktop is away, and that a page can only touch its own captures.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  CAPTURED_TAG,
  captureContent,
  captureTags,
  captureTitle,
  captureToVault,
  capturedPageBelongsTo,
  confirmCapture,
  confirmParkedCapture,
  discardParkedCapture,
  discardCapture,
  flushCaptureOutbox,
  listCaptured,
  parkCapture,
  parkedCaptureCount,
  withoutCapturedTag,
} from "@/background/capture-store";
import type { ApiClient } from "@/background/api-client";
import type { Credential } from "@/shared/types";
import { stores } from "./setup";

const entry = {
  username: "alice@example.com",
  password: "hunter2",
  url: "https://shop.example.com/login",
  domain: "example.com",
  isSignup: false,
  capturedAt: "2026-09-23T10:00:00.000Z",
};

function fakeApi(
  pages: Record<
    string,
    { title: string; tags: string[]; content: string; created_at?: string }
  > = {},
) {
  const api = {
    createPage: vi.fn(
      async (body: {
        title: string;
        content: string;
        folder?: string;
        tags?: string[];
      }) => {
        const path = `credentials/${body.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.md`;
        pages[path] = {
          title: body.title,
          tags: body.tags ?? [],
          content: body.content,
          created_at: "2026-09-23T10:00:00Z",
        };
        return {
          path,
          meta: { title: body.title, tags: body.tags ?? [] },
          content: body.content,
        };
      },
    ),
    patchSecretBlock: vi.fn(async () => ({ page: {}, etag: "v2" })),
    getPage: vi.fn(async (path: string) => {
      const page = pages[path];
      if (!page) throw new Error("not found");
      return {
        path,
        content: page.content,
        meta: { title: page.title, tags: page.tags, created_at: page.created_at ?? "" },
      };
    }),
    updateTags: vi.fn(async (path: string, tags: string[]) => {
      pages[path].tags = tags;
      return {};
    }),
    updateTitle: vi.fn(async (path: string, title: string) => {
      pages[path].title = title;
      return {};
    }),
    deletePage: vi.fn(async (path: string) => {
      delete pages[path];
    }),
    listPages: vi.fn(async () =>
      Object.entries(pages).map(([path, p]) => ({
        path,
        snippet: "",
        meta: {
          title: p.title,
          tags: p.tags,
          created_at: p.created_at ?? "",
          folder: "credentials",
        },
      })),
    ),
  } as unknown as ApiClient;
  return { api, pages };
}

beforeEach(() => {
  stores.session.clear();
});

describe("writing a capture", () => {
  it("makes an ordinary login page tagged captured, named after the account", async () => {
    const { api, pages } = fakeApi();

    const { pagePath, updatedExisting } = await captureToVault(api, [], entry);

    expect(updatedExisting).toBe(false);
    expect(pages[pagePath].title).toBe("alice@example.com at example.com");
    expect(pages[pagePath].tags).toEqual(["login", "example.com", CAPTURED_TAG]);
    expect(pages[pagePath].content).toBe(
      [
        ":::secret[example.com Login]",
        "username: alice@example.com",
        "password: hunter2",
        "url: https://shop.example.com/login",
        ":::",
      ].join("\n"),
    );
    expect(captureTitle("", "example.com")).toBe("example.com Login");
    expect(captureTags("x.test")).toContain(CAPTURED_TAG);
    expect(withoutCapturedTag(["login", "x.test", CAPTURED_TAG])).toEqual([
      "login",
      "x.test",
    ]);
    expect(captureContent(entry)).toContain("password: hunter2");
  });

  it("puts a retyped password onto the capture already waiting for that account, not a second page", async () => {
    const { api } = fakeApi();
    const waiting: Credential = {
      pagePath: "credentials/alice.md",
      pageTitle: "alice@example.com at example.com",
      label: "example.com Login",
      fields: { username: "Alice@Example.com", password: "old" },
      tags: ["login", "example.com", CAPTURED_TAG],
      captured: true,
    };
    const confirmed: Credential = {
      ...waiting,
      pagePath: "credentials/real.md",
      captured: false,
    };

    const result = await captureToVault(api, [confirmed, waiting], entry);

    expect(result).toEqual({ pagePath: "credentials/alice.md", updatedExisting: true });
    expect(api.patchSecretBlock).toHaveBeenCalledWith("credentials/alice.md", {
      label: "example.com Login",
      fields: { password: "hunter2", url: entry.url },
    });
    expect(api.createPage).not.toHaveBeenCalled();
  });

  it("never patches a capture waiting for another site, even for the same account", async () => {
    const { api } = fakeApi();
    const elsewhere: Credential = {
      pagePath: "credentials/alice-other.md",
      pageTitle: "alice@example.com at other.test",
      label: "other.test Login",
      fields: { username: "alice@example.com", password: "old" },
      tags: ["login", "other.test", CAPTURED_TAG],
      captured: true,
    };

    const result = await captureToVault(api, [elsewhere], entry);

    expect(result.updatedExisting).toBe(false);
    expect(api.patchSecretBlock).not.toHaveBeenCalled();
  });

  it("never touches a confirmed login for the same account; that is the bar's Update", async () => {
    const { api } = fakeApi();
    const confirmed: Credential = {
      pagePath: "credentials/real.md",
      pageTitle: "Alice",
      label: "example.com Login",
      fields: { username: "alice@example.com", password: "old" },
    };

    const result = await captureToVault(api, [confirmed], entry);

    expect(result.updatedExisting).toBe(false);
    expect(api.patchSecretBlock).not.toHaveBeenCalled();
    expect(api.createPage).toHaveBeenCalled();
  });
});

describe("confirming and discarding", () => {
  it("confirm drops the tag and takes the owner's title; discard deletes the page", async () => {
    const { api, pages } = fakeApi();
    const { pagePath } = await captureToVault(api, [], entry);

    await confirmCapture(api, pagePath, "Shop account");
    expect(pages[pagePath].tags).toEqual(["login", "example.com"]);
    expect(pages[pagePath].title).toBe("Shop account");

    const other = await captureToVault(api, [], {
      ...entry,
      username: "bob@example.com",
    });
    await discardCapture(api, other.pagePath);
    expect(pages[other.pagePath]).toBeUndefined();
  });

  it("lets a page touch only captures from its own site, and the popup any capture", async () => {
    const { api } = fakeApi();
    const { pagePath } = await captureToVault(api, [], entry);
    const confirmed = await captureToVault(api, [], {
      ...entry,
      domain: "other.test",
      username: "c@other.test",
    });
    await confirmCapture(api, confirmed.pagePath);

    expect(await capturedPageBelongsTo(api, pagePath, "example.com")).toBe(true);
    expect(await capturedPageBelongsTo(api, pagePath, "evil.test")).toBe(false);
    expect(await capturedPageBelongsTo(api, pagePath, null)).toBe(true);
    expect(await capturedPageBelongsTo(api, confirmed.pagePath, null)).toBe(false);
    expect(await capturedPageBelongsTo(api, "credentials/missing.md", null)).toBe(false);
  });
});

describe("listing", () => {
  it("lists only captures, newest first, without passwords", async () => {
    const { api, pages } = fakeApi();
    const older = await captureToVault(api, [], entry);
    pages[older.pagePath].created_at = "2026-09-22T09:00:00Z";
    await captureToVault(api, [], {
      ...entry,
      username: "bob@example.com",
      capturedAt: "2026-09-23T10:00:00Z",
    });
    const confirmed = await captureToVault(api, [], {
      ...entry,
      username: "carol@example.com",
    });
    await confirmCapture(api, confirmed.pagePath);

    const items = await listCaptured(api);

    expect(items.map((i) => i.username)).toEqual([
      "bob@example.com",
      "alice@example.com",
    ]);
    expect(items[0]).toMatchObject({ domain: "example.com", url: entry.url });
    expect(JSON.stringify(items)).not.toContain("hunter2");
  });
});

describe("the outbox", () => {
  it("holds one capture per account and site, and writes them when the vault is back", async () => {
    await parkCapture(entry);
    await parkCapture({ ...entry, password: "newer" });
    await parkCapture({ ...entry, username: "bob@example.com" });
    expect(await parkedCaptureCount()).toBe(2);

    const { api, pages } = fakeApi();
    const written = await flushCaptureOutbox(api, async () => []);

    expect(written).toBe(2);
    expect(await parkedCaptureCount()).toBe(0);
    const alice = Object.values(pages).find((p) => p.title.startsWith("alice@"));
    expect(alice?.content).toContain("password: newer");
    expect(alice?.content).not.toContain("hunter2");
  });

  it("writes a parked capture the owner already confirmed as an ordinary login", async () => {
    await parkCapture(entry);
    expect(await confirmParkedCapture("example.com", "ALICE@example.com")).toBe(true);
    expect(await confirmParkedCapture("example.com", "nobody@example.com")).toBe(false);

    const { api, pages } = fakeApi();
    await flushCaptureOutbox(api, async () => []);

    const [page] = Object.values(pages);
    expect(page.tags).toEqual(["login", "example.com"]);
  });

  it("drops a parked capture the owner discarded", async () => {
    await parkCapture(entry);
    expect(await discardParkedCapture("example.com", "alice@example.com")).toBe(true);
    expect(await discardParkedCapture("example.com", "alice@example.com")).toBe(false);
    expect(await parkedCaptureCount()).toBe(0);
  });

  it("keeps what still cannot be written", async () => {
    await parkCapture(entry);
    const api = {
      createPage: vi.fn(async () => {
        throw new Error("offline");
      }),
    } as unknown as ApiClient;

    const written = await flushCaptureOutbox(api, async () => []);

    expect(written).toBe(0);
    expect(await parkedCaptureCount()).toBe(1);
  });
});
