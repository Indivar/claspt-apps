// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { describe, it, expect } from "vitest";
import {
  extractSecretBlocks,
  parseSecretFields,
  parseSecretOpen,
  unescapeLabel,
} from "@claspt/shared/secret-parser";

describe("parseSecretOpen", () => {
  it("reads a plain label", () => {
    expect(parseSecretOpen(":::secret[GitHub]")).toBe("GitHub");
  });

  it("ignores leading and trailing whitespace", () => {
    expect(parseSecretOpen("   :::secret[GitHub]  ")).toBe("GitHub");
  });

  it("reads an escaped closing bracket", () => {
    // The desktop writes `mongodb.com[2]` as `mongodb.com[2\]`.
    expect(parseSecretOpen(":::secret[mongodb.com[2\\]]")).toBe("mongodb.com[2]");
  });

  it("reads a label that ends in a backslash", () => {
    // `escape_label` doubles it, so the run before `]` is even and terminates.
    expect(parseSecretOpen(":::secret[C:\\\\]")).toBe("C:\\");
  });

  it("returns null for a line that only mentions the fence", () => {
    expect(parseSecretOpen("see :::secret[X] for an example")).toBeNull();
    expect(parseSecretOpen(":::secret[unterminated")).toBeNull();
    expect(parseSecretOpen("plain text")).toBeNull();
  });
});

describe("unescapeLabel", () => {
  it("unescapes only the two sequences the desktop writes", () => {
    expect(unescapeLabel("a\\]b")).toBe("a]b");
    expect(unescapeLabel("a\\\\b")).toBe("a\\b");
  });

  it("leaves other backslash sequences alone", () => {
    // Builds before 3.0.11 never escaped `\`, so `C:\Users\me` is on disk raw
    // and has to read back unchanged.
    expect(unescapeLabel("C:\\Users\\me")).toBe("C:\\Users\\me");
  });
});

describe("parseSecretFields", () => {
  it("splits on the first colon, space or not", () => {
    expect(parseSecretFields("username: me\npassword:hunter2")).toEqual({
      username: "me",
      password: "hunter2",
    });
  });

  it("keeps colons inside the value", () => {
    expect(parseSecretFields("url: https://example.com:8443/x")).toEqual({
      url: "https://example.com:8443/x",
    });
  });

  it("lowercases keys and skips blank or valueless lines", () => {
    expect(parseSecretFields("URL_Match: host\n\nnote:\n")).toEqual({ url_match: "host" });
  });
});

describe("extractSecretBlocks", () => {
  it("extracts a simple block", () => {
    const blocks = extractSecretBlocks(
      ["# Note", "", ":::secret[GitHub]", "username: me", "password: pw", ":::", "", "trailing"].join("\n"),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].label).toBe("GitHub");
    expect(blocks[0].fields).toEqual({ username: "me", password: "pw" });
  });

  it("extracts several blocks from one page", () => {
    const blocks = extractSecretBlocks(
      [":::secret[One]", "password: a", ":::", ":::secret[Two]", "password: b", ":::"].join("\n"),
    );
    expect(blocks.map((b) => b.label)).toEqual(["One", "Two"]);
  });

  it("reads a credential whose label contains a bracket", () => {
    // The old regex used `[^\]]*` and could not parse this at all, so the
    // credential silently disappeared from the extension.
    const blocks = extractSecretBlocks(
      [":::secret[mongodb.com[2\\]]", "password: pw", ":::"].join("\n"),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].label).toBe("mongodb.com[2]");
    expect(blocks[0].fields["password"]).toBe("pw");
  });

  it("skips examples inside a fenced code block", () => {
    // The desktop deliberately leaves these as literal markdown examples and
    // never encrypts them, so the extension must not offer them for fill.
    const blocks = extractSecretBlocks(
      [
        "How to write one:",
        "```",
        ":::secret[Example]",
        "password: not-a-real-secret",
        ":::",
        "```",
        ":::secret[Real]",
        "password: real",
        ":::",
      ].join("\n"),
    );
    expect(blocks.map((b) => b.label)).toEqual(["Real"]);
  });

  it("skips examples inside a tilde-fenced code block", () => {
    const blocks = extractSecretBlocks(
      ["~~~", ":::secret[Example]", "password: x", ":::", "~~~"].join("\n"),
    );
    expect(blocks).toHaveLength(0);
  });

  it("only closes on a line that is exactly `:::`", () => {
    // A body line containing `:::` used to truncate the block early, dropping
    // every field after it.
    const blocks = extractSecretBlocks(
      [":::secret[X]", "note: uses ::: as a separator", "password: pw", ":::"].join("\n"),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].fields["password"]).toBe("pw");
  });

  it("ignores an unterminated block", () => {
    const blocks = extractSecretBlocks([":::secret[X]", "password: pw"].join("\n"));
    expect(blocks).toHaveLength(0);
  });

  it("returns nothing for content with no blocks", () => {
    expect(extractSecretBlocks("just a note\n")).toEqual([]);
  });
});
