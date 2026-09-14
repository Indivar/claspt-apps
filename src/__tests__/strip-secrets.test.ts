// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { describe, it, expect } from "vitest";
import { stripSecretValues } from "@/lib/strip-secrets";

describe("stripSecretValues", () => {
  it("redacts a single-value secret body, keeping the fence", () => {
    const input = [":::secret[API Key]", "sk-live-abc123", ":::"].join("\n");
    const out = stripSecretValues(input);
    expect(out).toBe([":::secret[API Key]", "[REDACTED]", ":::"].join("\n"));
    expect(out).not.toContain("sk-live-abc123");
  });

  it("redacts a multi-line secret body fully", () => {
    const input = [
      ":::secret[AWS]",
      "access: AKIAEXAMPLE",
      "secret: wJalrXUtnEXAMPLEKEY",
      ":::",
    ].join("\n");
    const out = stripSecretValues(input);
    expect(out).not.toContain("AKIAEXAMPLE");
    expect(out).not.toContain("wJalrXUtnEXAMPLEKEY");
    expect(out).toContain("[REDACTED]");
  });

  it("does NOT under-redact when a value line contains an inline ':::'", () => {
    // Regression for the under-redaction gap: the old regex matched a bare
    // ':::' anywhere, so an inline ':::' inside the value terminated the match
    // early and left the rest of the value in cleartext. Anchoring the closing
    // fence to its own line (`^:::`) redacts the whole value up to the real
    // fence — matching how the encryptor treats the first line-level ':::' as
    // the close.
    const input = [":::secret[Token]", "value:::with:::inline:::colons", ":::"].join(
      "\n",
    );
    const out = stripSecretValues(input);
    expect(out).not.toContain("value:::with:::inline:::colons");
    expect(out).toBe([":::secret[Token]", "[REDACTED]", ":::"].join("\n"));
  });

  it("leaves non-secret content untouched", () => {
    const input = "# Heading\n\nSome notes here.\n";
    expect(stripSecretValues(input)).toBe(input);
  });

  it("redacts every secret block when several are present", () => {
    const input = [
      ":::secret[One]",
      "value-one",
      ":::",
      "",
      "middle note",
      "",
      ":::secret[Two]",
      "value-two",
      ":::",
    ].join("\n");
    const out = stripSecretValues(input);
    expect(out).not.toContain("value-one");
    expect(out).not.toContain("value-two");
    expect(out).toContain("middle note");
    expect(out.match(/\[REDACTED\]/g)?.length).toBe(2);
  });

  // ── Under-redaction bypasses ────────────────────────────────────────
  //
  // Everything below reaches localStorage on every keystroke via
  // EditorPane, BEFORE the content is ever encrypted. A miss here writes a
  // live secret into unencrypted browser storage that survives vault lock.

  it("redacts when the label contains an escaped bracket", () => {
    // The label character class stopped at the first `]`, so a label written
    // by the block writer as `mongodb.com[2\]` never matched and the whole
    // body was stored unredacted.
    const input = [
      ":::secret[mongodb.com[2\\]]",
      "password: leaky-label-value",
      ":::",
    ].join("\n");
    const out = stripSecretValues(input);
    expect(out).not.toContain("leaky-label-value");
  });

  it("redacts when the file uses CRLF line endings", () => {
    // The pattern required `\n` immediately after the label's `]`. With CRLF
    // the next character is `\r`, so nothing matched.
    const input = [":::secret[API]", "password: leaky-crlf-value", ":::"].join("\r\n");
    const out = stripSecretValues(input);
    expect(out).not.toContain("leaky-crlf-value");
  });

  it("redacts when the closing fence is indented", () => {
    // Rust closes a block on any line that trims to `:::`; the pattern
    // required column zero, so an indented fence left the body exposed.
    const input = [":::secret[API]", "password: leaky-indent-value", "  :::"].join("\n");
    const out = stripSecretValues(input);
    expect(out).not.toContain("leaky-indent-value");
  });

  it("redacts an unterminated block through to the end of the content", () => {
    // A block still being typed has no closing fence yet — which is exactly
    // when the draft is written. No fence meant no match meant no redaction.
    const input = [":::secret[API]", "password: leaky-unclosed-value"].join("\n");
    const out = stripSecretValues(input);
    expect(out).not.toContain("leaky-unclosed-value");
  });

  it("redacts a secret block sitting inside a markdown code fence", () => {
    // Fenced blocks are not encrypted on disk, so their contents are the ONE
    // case where a real cleartext value is sitting in the editor buffer.
    // Redacting them costs a documentation example its body in a
    // crash-recovery draft; not redacting them leaks a live secret.
    const input = [
      "```markdown",
      ":::secret[Example]",
      "password: leaky-fenced-value",
      ":::",
      "```",
    ].join("\n");
    const out = stripSecretValues(input);
    expect(out).not.toContain("leaky-fenced-value");
  });
});
