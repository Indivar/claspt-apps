// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Every field that holds a credential must carry `SECRET_INPUT_PROPS`.
 *
 * macOS text substitution rewrites what is typed: `test123` entered into a
 * revealed password field became `Test123`, silently. A field that alters a
 * credential on its way in is a data-loss bug — the vault ends up with a
 * password its owner never chose.
 *
 * This scans the source rather than rendering, because the risk is a field
 * someone adds later without knowing the rule exists. A rendering test would
 * only cover the fields we remembered to write a test for, which is the same
 * fields we would have remembered to guard.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith(".tsx") ? [full] : [];
  });
}

/** An element is a credential field if it is a password input, a field that
 *  toggles to plain text behind a "show" control, or the recovery key box. */
const CREDENTIAL_LINE =
  /type="password"|type=\{showPassword|type=\{show\s|id="recovery-key"/;

describe("credential fields", () => {
  const files = sourceFiles(join(process.cwd(), "src"));

  it("finds the components to check", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("every credential field opts out of autocapitalise, autocorrect and autofill", () => {
    const offenders: string[] = [];

    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!CREDENTIAL_LINE.test(line)) return;
        // The guard is spread on the same element, so look within the few
        // lines around the match rather than the whole file.
        const window = lines.slice(Math.max(0, i - 12), i + 12).join("\n");
        if (!window.includes("SECRET_INPUT_PROPS")) {
          offenders.push(`${file.replace(process.cwd(), ".")}:${i + 1}  ${line.trim()}`);
        }
      });
    }

    expect(
      offenders,
      `These credential fields are missing {...SECRET_INPUT_PROPS}, so macOS may ` +
        `capitalise or autocorrect what is typed into them:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
