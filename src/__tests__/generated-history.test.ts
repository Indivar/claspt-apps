// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { describe, it, expect } from "vitest";
import {
  extractSecretBlocks,
  removeBlock,
  renderHistoryBlock,
  setFieldInBlock,
} from "@claspt/shared";

/** Array index access under `noUncheckedIndexedAccess`, with a real failure if empty. */
function at<T>(items: T[], index: number): T {
  const value = items[index];
  if (value === undefined) throw new Error(`expected an item at index ${index}`);
  return value;
}

const AT = new Date("2026-09-04T16:43:07Z");

function page(...blocks: string[]): string {
  return ["# Generated passwords", "", ...blocks].join("\n\n") + "\n";
}

const entry = {
  password: "a-generated-value",
  site: "accounts.google.com",
  source: "desktop app" as const,
  used: false,
  generated: AT.toISOString(),
};

describe("renderHistoryBlock", () => {
  it("renders a block the parser reads back", () => {
    const block = renderHistoryBlock(entry, AT);
    const parsed = extractSecretBlocks(block);
    expect(parsed).toHaveLength(1);
    expect(at(parsed, 0).fields["password"]).toBe("a-generated-value");
    expect(at(parsed, 0).fields["url_match"]).toBe("never");
  });

  it("escapes a label so a site containing a bracket survives the round trip", () => {
    const odd = { ...entry, site: "weird]host" };
    const parsed = extractSecretBlocks(renderHistoryBlock(odd, AT));
    expect(at(parsed, 0).label).toContain("weird]host");
  });
});

describe("setFieldInBlock", () => {
  it("flips an existing field", () => {
    const content = page(renderHistoryBlock(entry, AT));
    const label = at(extractSecretBlocks(content), 0).label;

    const updated = setFieldInBlock(content, label, "used", "yes");
    expect(at(extractSecretBlocks(updated), 0).fields["used"]).toBe("yes");
  });

  it("adds a field that is not there yet", () => {
    const content = ["# Note", "", ":::secret[X]", "password: pw", ":::", ""].join("\n");
    const updated = setFieldInBlock(content, "X", "used", "yes");
    const fields = at(extractSecretBlocks(updated), 0).fields;
    expect(fields["used"]).toBe("yes");
    expect(fields["password"]).toBe("pw");
  });

  it("leaves other blocks untouched", () => {
    const a = renderHistoryBlock(entry, AT);
    const b = renderHistoryBlock(
      { ...entry, password: "second" },
      new Date("2026-09-04T16:44:00Z"),
    );
    const content = page(a, b);
    const labels = extractSecretBlocks(content).map((x) => x.label);

    const updated = setFieldInBlock(content, at(labels, 0), "used", "yes");
    const after = extractSecretBlocks(updated);
    expect(at(after, 0).fields["used"]).toBe("yes");
    expect(at(after, 1).fields["used"]).toBe("no");
    expect(at(after, 1).fields["password"]).toBe("second");
  });

  it("does nothing when the label is not present", () => {
    const content = page(renderHistoryBlock(entry, AT));
    expect(setFieldInBlock(content, "no such label", "used", "yes")).toBe(content);
  });
});

describe("removeBlock", () => {
  it("removes only the named block", () => {
    const a = renderHistoryBlock(entry, AT);
    const b = renderHistoryBlock(
      { ...entry, password: "keep-me" },
      new Date("2026-09-04T16:44:00Z"),
    );
    const content = page(a, b);
    const labels = extractSecretBlocks(content).map((x) => x.label);

    const updated = removeBlock(content, at(labels, 0));
    const after = extractSecretBlocks(updated);
    expect(after).toHaveLength(1);
    expect(at(after, 0).fields["password"]).toBe("keep-me");
  });

  it("keeps the page's own text", () => {
    const content = page(renderHistoryBlock(entry, AT));
    const label = at(extractSecretBlocks(content), 0).label;
    expect(removeBlock(content, label)).toContain("# Generated passwords");
  });

  it("does nothing when the label is not present", () => {
    const content = page(renderHistoryBlock(entry, AT));
    expect(removeBlock(content, "no such label")).toBe(content);
  });
});
