// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { describe, expect, it } from "vitest";
import { CredentialCache } from "@/background/credential-cache";
import type { ApiClient } from "@/background/api-client";

function page(path: string, title: string, label: string, user: string, url?: string) {
  const lines = [`:::secret[${label}]`, `username: ${user}`, `password: pw-for-${user}`];
  if (url) lines.push(`url: ${url}`);
  lines.push(":::");
  return { path, meta: { title, tags: [] as string[] }, content: lines.join("\n") };
}

const pages = [
  page(
    "imported/a.md",
    "google - a@example.com",
    "google - a@example.com",
    "a@example.com",
    "https://accounts.google.com",
  ),
  page(
    "imported/b.md",
    "google - b@example.com",
    "google - b@example.com",
    "b@example.com",
    "https://accounts.google.com",
  ),
  page("imported/c.md", "google - c@example.com", "google - c@example.com", "c@example.com"),
  page(
    "notes/d.md",
    "Team onboarding",
    "Work mail",
    "d@example.com",
    "https://mail.google.com",
  ),
  page(
    "imported/e.md",
    "github - e@example.com",
    "github - e@example.com",
    "e@example.com",
    "https://github.com",
  ),
];
const byPath = new Map(pages.map((p) => [p.path, p]));

/** A desktop whose full-text search returns only `searchHits`, as a capped, ranked search does. */
function api(searchHits: string[]): ApiClient {
  return {
    search: async () =>
      searchHits.map((p) => ({
        path: p,
        title: byPath.get(p)?.meta.title ?? "",
        snippet: "",
        score: 1,
      })),
    findSecrets: async (q: string) =>
      pages
        .filter((p) => p.meta.title.toLowerCase().includes(q.toLowerCase()))
        .map((p) => ({
          label: p.meta.title,
          page_title: p.meta.title,
          page_path: p.path,
          folder: p.path.split("/")[0] ?? "",
          tags: [],
          created_at: "2026-04-25T00:00:00Z",
          reference_prefix: "",
        })),
    getPage: async (path: string) => {
      const p = byPath.get(path);
      if (!p) throw new Error("gone");
      return p;
    },
  } as unknown as ApiClient;
}

describe("CredentialCache", () => {
  it("lists every login whose label names the site, not only the ones full-text search ranked", async () => {
    // The bug: search returned its top results out of hundreds of pages that
    // mention google somewhere, and the logins beyond that cut-off were missing.
    const cache = new CredentialCache(api(["imported/a.md", "notes/d.md"]));
    const creds = await cache.getCredentialsForUrl(
      "https://accounts.google.com/v3/signin",
    );
    expect(creds.map((c) => c.label).sort()).toEqual([
      "Work mail",
      "google - a@example.com",
      "google - b@example.com",
      "google - c@example.com",
    ]);
  });

  it("still keeps a login that only full-text search knows about, and leaves other sites out", async () => {
    const cache = new CredentialCache(api(["notes/d.md", "imported/e.md"]));
    const creds = await cache.getCredentialsForUrl("https://mail.google.com/");
    const labels = creds.map((c) => c.label);
    expect(labels).toContain("Work mail");
    expect(labels).not.toContain("github - e@example.com");
  });

  it("finds a login by its label in the popup search, without the search cap", async () => {
    const cache = new CredentialCache(api([]));
    const creds = await cache.searchCredentials("b@example.com");
    expect(creds.map((c) => c.label)).toEqual(["google - b@example.com"]);
  });
});
