// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { describe, it, expect } from "vitest";
import { buildFieldPatch } from "@/shared/patch-field";

describe("buildFieldPatch", () => {
  it("sets a field when a value is given", () => {
    expect(buildFieldPatch("credentials/a.md", "GitHub", "note", "hello")).toEqual({
      type: "PATCH_SECRET_BLOCK",
      pagePath: "credentials/a.md",
      label: "GitHub",
      fields: { note: "hello" },
      deleteFields: [],
    });
  });

  it("deletes the field when the value is empty", () => {
    expect(buildFieldPatch("credentials/a.md", "GitHub", "url_match", "")).toEqual({
      type: "PATCH_SECRET_BLOCK",
      pagePath: "credentials/a.md",
      label: "GitHub",
      fields: {},
      deleteFields: ["url_match"],
    });
  });
});
