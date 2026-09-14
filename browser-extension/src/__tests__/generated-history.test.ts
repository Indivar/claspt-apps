// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { describe, it, expect } from "vitest";
import {
  HISTORY_FOLDER,
  historyBlockFields,
  historyBlockLabel,
  monthPageIntro,
  monthPageTitle,
  credentialRef,
  parseHistoryBlock,
  sortNewestFirst,
  unusedEntriesOlderThan,
  type GeneratedEntry,
  type StoredGeneratedEntry,
} from "@claspt/shared/generated-history";

const AT = new Date("2026-09-04T16:43:07.123Z");

function entry(over: Partial<GeneratedEntry> = {}): GeneratedEntry {
  return {
    password: "hunter2-but-longer",
    site: "accounts.google.com",
    source: "browser extension",
    used: false,
    generated: AT.toISOString(),
    ...over,
  };
}

function stored(over: Partial<StoredGeneratedEntry> = {}): StoredGeneratedEntry {
  return { pagePath: `${HISTORY_FOLDER}/2026-09.md`, label: "l", ...entry(), ...over };
}

describe("page and block naming", () => {
  it("names a page after the month it covers", () => {
    expect(monthPageTitle(AT)).toBe("Generated passwords — September 2026");
  });

  it("puts the site and the time in the label", () => {
    const label = historyBlockLabel("accounts.google.com", AT);
    expect(label).toContain("accounts.google.com");
    expect(label).toMatch(/\d{1,2} Sep \d{2}:\d{2}:\d{2}$/);
  });

  it("distinguishes two generations in the same minute", () => {
    // Without seconds these would share a label and the second would be merged
    // into the first, losing exactly the password this exists to keep.
    const a = historyBlockLabel("example.com", new Date("2026-09-04T16:43:07Z"));
    const b = historyBlockLabel("example.com", new Date("2026-09-04T16:43:44Z"));
    expect(a).not.toBe(b);
  });

  it("labels a generation made outside any page", () => {
    expect(historyBlockLabel("", AT)).toContain("no site");
  });

  it("writes an intro that names no secret", () => {
    const intro = monthPageIntro(AT);
    expect(intro).toContain("September 2026");
    expect(intro).not.toContain("hunter2");
    expect(intro).not.toContain(":::");
  });
});

describe("historyBlockFields", () => {
  it("always disables URL matching", () => {
    // Without this the entry scores as a credential for its own site, so the
    // picker on accounts.google.com would offer a rejected password.
    expect(historyBlockFields(entry())["url_match"]).toBe("never");
  });

  it("records where it came from and whether it was taken up", () => {
    const fields = historyBlockFields(entry({ used: true, source: "desktop app" }));
    expect(fields["used"]).toBe("yes");
    expect(fields["source"]).toBe("desktop app");
    expect(fields["site"]).toBe("accounts.google.com");
  });

  it("marks an absent site rather than writing an empty field", () => {
    expect(historyBlockFields(entry({ site: "" }))["site"]).toBe("—");
  });
});

describe("parseHistoryBlock", () => {
  it("round-trips an entry", () => {
    const parsed = parseHistoryBlock("p.md", "lbl", historyBlockFields(entry()));
    expect(parsed).toMatchObject({
      pagePath: "p.md",
      label: "lbl",
      password: "hunter2-but-longer",
      site: "accounts.google.com",
      source: "browser extension",
      used: false,
    });
  });

  it("reads the used flag back", () => {
    expect(parseHistoryBlock("p.md", "l", historyBlockFields(entry({ used: true })))?.used).toBe(true);
  });

  it("turns the placeholder site back into nothing", () => {
    expect(parseHistoryBlock("p.md", "l", historyBlockFields(entry({ site: "" })))?.site).toBe("");
  });

  it("ignores a block that is not a history entry", () => {
    expect(parseHistoryBlock("p.md", "l", { username: "me", password: "pw" })).toBeNull();
    expect(parseHistoryBlock("p.md", "l", { generated: AT.toISOString() })).toBeNull();
  });
});

describe("unusedEntriesOlderThan", () => {
  const now = Date.parse("2026-09-04T00:00:00Z");
  const daysAgo = (n: number) => new Date(now - n * 86_400_000).toISOString();

  it("takes only entries that were never used", () => {
    const entries = [
      stored({ label: "old-unused", generated: daysAgo(40), used: false }),
      stored({ label: "old-used", generated: daysAgo(40), used: true }),
    ];
    expect(unusedEntriesOlderThan(entries, 30, now).map((e) => e.label)).toEqual(["old-unused"]);
  });

  it("leaves recent ones alone whatever their state", () => {
    // A password generated moments ago and not yet pasted anywhere must never
    // be swept away mid-task.
    const entries = [stored({ label: "fresh", generated: daysAgo(1), used: false })];
    expect(unusedEntriesOlderThan(entries, 30, now)).toEqual([]);
  });

  it("ignores an entry with an unreadable timestamp", () => {
    const entries = [stored({ label: "broken", generated: "not-a-date", used: false })];
    expect(unusedEntriesOlderThan(entries, 30, now)).toEqual([]);
  });
});

describe("sortNewestFirst", () => {
  it("puts the most recent first", () => {
    const sorted = sortNewestFirst([
      stored({ label: "older", generated: "2026-09-01T00:00:00Z" }),
      stored({ label: "newer", generated: "2026-09-04T00:00:00Z" }),
    ]);
    expect(sorted.map((e) => e.label)).toEqual(["newer", "older"]);
  });
});

describe("credential linkage", () => {
  it("omits the field when a password was not generated for a credential", () => {
    expect(historyBlockFields(entry())["for"]).toBeUndefined();
  });

  it("round-trips the credential it was generated for", () => {
    const ref = credentialRef("credentials/bank.md", "Bank Login");
    const fields = historyBlockFields(entry({ forCredential: ref }));
    expect(fields["for"]).toBe(ref);
    expect(parseHistoryBlock("p.md", "l", fields)?.forCredential).toBe(ref);
  });

  it("reads an entry with no linkage back as undefined, not empty string", () => {
    expect(parseHistoryBlock("p.md", "l", historyBlockFields(entry()))?.forCredential).toBeUndefined();
  });
});

describe("source", () => {
  it("keeps each platform distinct", () => {
    for (const source of ["browser extension", "desktop app", "mobile app"] as const) {
      const parsed = parseHistoryBlock("p.md", "l", historyBlockFields(entry({ source })));
      expect(parsed?.source).toBe(source);
    }
  });

  it("falls back to the extension for an entry written before sources were tagged", () => {
    const fields = historyBlockFields(entry());
    delete fields["source"];
    expect(parseHistoryBlock("p.md", "l", fields)?.source).toBe("browser extension");
  });
});
