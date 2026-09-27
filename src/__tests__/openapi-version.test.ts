// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { describe, expect, it } from "vitest";
// @ts-expect-error a plain ES module script without a declaration file
import {
  readOpenapiVersion,
  writeOpenapiVersion,
} from "../../scripts/openapi-version.js";

const lf =
  "openapi: 3.1.0\ninfo:\n  title: Claspt Local API\n  version: 4.1.9\n  license:\n    name: x\npaths: {}\n";
const crlf = lf.replace(/\n/g, "\r\n");

describe("the OpenAPI version line", () => {
  it("is read with either line ending", () => {
    expect(readOpenapiVersion(lf)).toBe("4.1.9");
    // A Windows checkout: this is what stopped the 4.2.0 Windows build.
    expect(readOpenapiVersion(crlf)).toBe("4.1.9");
    expect(readOpenapiVersion("openapi: 3.1.0\npaths: {}\n")).toBeNull();
  });

  it("is written in place, keeping the file's own line endings", () => {
    expect(writeOpenapiVersion(lf, "4.2.0")).toBe(lf.replace("4.1.9", "4.2.0"));
    expect(writeOpenapiVersion(crlf, "4.2.0")).toBe(crlf.replace("4.1.9", "4.2.0"));
    expect(writeOpenapiVersion("nothing", "4.2.0")).toBeNull();
  });
});
