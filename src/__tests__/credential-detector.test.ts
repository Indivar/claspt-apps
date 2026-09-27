// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { describe, expect, it } from "vitest";
import {
  applyConversion,
  detectCredentials,
  generateSecretBlocks,
} from "@/lib/credential-detector";

const pairs = (text: string) => detectCredentials(text).map((c) => [c.key, c.value]);

describe("detectCredentials", () => {
  it("keeps every key and value line of a selection, not only the ones that look secret", () => {
    // The bug: only "Password" was offered; the other two lines were dropped.
    const text =
      "Project Name: testing\nProject Region: eu-central-1\nPassword : password123";
    expect(pairs(text)).toEqual([
      ["Project Name", "testing"],
      ["Project Region", "eu-central-1"],
      ["Password", "password123"],
    ]);
  });

  it("reads list items and env-style lines in any case", () => {
    expect(pairs("- Host: db.example.com\n* Port: 5432\n1. User: app")).toEqual([
      ["Host", "db.example.com"],
      ["Port", "5432"],
      ["User", "app"],
    ]);
    expect(pairs("DB_PASSWORD=hunter2\nproject_id=abc-123\n# comment=ignored")).toEqual([
      ["DB_PASSWORD", "hunter2"],
      ["project_id", "abc-123"],
    ]);
  });

  it("does not turn prose into fields", () => {
    expect(
      pairs("Remember to rotate this every quarter: it matters a lot to us all here."),
    ).toEqual([]);
    expect(pairs("Done.: yes")).toEqual([]);
    expect(pairs("# Heading: not a field")).toEqual([]);
    expect(pairs("Key:")).toEqual([]);
  });

  it("reads tables and user / password lines as before", () => {
    expect(
      pairs("| Key | Value |\n|---|---|\n| Region | eu-west-1 |\n| Token | t0k3n |"),
    ).toEqual([
      ["Region", "eu-west-1"],
      ["Token", "t0k3n"],
    ]);
    expect(pairs("│ Key │ Value │\n│ Host │ h1 │")).toEqual([["Host", "h1"]]);
    expect(pairs("ada@example.com / Pass123!")).toEqual([
      ["Email", "ada@example.com"],
      ["Password", "Pass123!"],
    ]);
  });

  it("drops duplicates", () => {
    expect(pairs("Host: a\nHost: a\nHost: b")).toEqual([
      ["Host", "a"],
      ["Host", "b"],
    ]);
  });
});

describe("generateSecretBlocks", () => {
  const fields = detectCredentials("Project Name: testing\nPassword: pw");

  it("writes one block with every field, or one block per field", () => {
    expect(generateSecretBlocks(fields, "AWS", "one")).toBe(
      ":::secret[AWS]\nProject Name: testing\nPassword: pw\n:::\n",
    );
    expect(generateSecretBlocks(fields, "AWS", "separate")).toBe(
      ":::secret[Project Name]\nProject Name: testing\n:::\n\n:::secret[Password]\nPassword: pw\n:::\n",
    );
  });

  it("escapes a closing bracket in the label and writes nothing for no fields", () => {
    expect(generateSecretBlocks(fields, "a]b", "one")).toContain(":::secret[a\\]b]");
    expect(generateSecretBlocks([], "x", "one")).toBe("");
  });
});

describe("applyConversion", () => {
  const block = (text: string, keys: string[]) => {
    const fields = detectCredentials(text).filter((c) => keys.includes(c.key));
    return applyConversion(text, fields, generateSecretBlocks(fields, "AWS", "one"));
  };

  it("moves only the converted lines into the block and leaves the rest where it was", () => {
    const text =
      "Notes for the team.\nProject Name: testing\nPassword: pw\nCall Ada on Monday.";
    expect(block(text, ["Project Name", "Password"])).toBe(
      "Notes for the team.\n:::secret[AWS]\nProject Name: testing\nPassword: pw\n:::\nCall Ada on Monday.",
    );
  });

  it("keeps an unticked field in the page as it was", () => {
    const text = "Project Name: testing\nProject Region: eu-central-1\nPassword: pw";
    expect(block(text, ["Password"])).toBe(
      "Project Name: testing\nProject Region: eu-central-1\n:::secret[AWS]\nPassword: pw\n:::",
    );
  });

  it("takes a whole table with its frame when every row went, and keeps the frame otherwise", () => {
    const table =
      "Before\n| Key | Value |\n|---|---|\n| Host | h1 |\n| Token | t1 |\nAfter";
    expect(block(table, ["Host", "Token"])).toBe(
      "Before\n:::secret[AWS]\nHost: h1\nToken: t1\n:::\nAfter",
    );
    expect(block(table, ["Token"])).toBe(
      "Before\n| Key | Value |\n|---|---|\n| Host | h1 |\n:::secret[AWS]\nToken: t1\n:::\nAfter",
    );
  });

  it("removes a two-field line only when both fields were converted", () => {
    const text = "ada@example.com / Pass123!\nnext";
    expect(block(text, ["Password"])).toBe(
      ":::secret[AWS]\nPassword: Pass123!\n:::\nada@example.com / Pass123!\nnext",
    );
    expect(block(text, ["Email", "Password"])).toBe(
      ":::secret[AWS]\nEmail: ada@example.com\nPassword: Pass123!\n:::\nnext",
    );
  });

  it("changes nothing when nothing was converted", () => {
    expect(applyConversion("a: b\nc", [], "")).toBe("a: b\nc");
  });
});
