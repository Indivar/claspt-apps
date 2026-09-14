#!/usr/bin/env node
// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

// Every source file carries a copyright header naming the owner and the terms
// it is published under. Public components say PolyForm Shield; the private
// components (mobile, server, sync, sharing) say proprietary. This script is
// the single definition of both the text and the boundary, so the header can
// never drift from the licence and a file cannot be exported into the public
// repository under the wrong terms.
//
//   node scripts/check-headers.mjs          exit 1 and list files that are wrong
//   node scripts/check-headers.mjs --fix    insert or correct headers in place
//
// Runs over `git ls-files`, so generated and ignored trees never count.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const OWNER = "Indivar Software Solutions Limited, Auckland, New Zealand";
const FIRST_YEAR = 2025;
const YEAR = new Date().getFullYear();

const PUBLIC_TERMS =
  "Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.";
const PRIVATE_TERMS =
  "Proprietary and confidential. All rights reserved. Not for distribution.";

/**
 * Paths that stay in the private product, read from `.publicignore` so the
 * header stamped on a file and the public export in phase 8 can never
 * disagree about where the boundary is.
 */
const PRIVATE_PREFIXES = readFileSync(".publicignore", "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));

const EXTENSIONS = new Set([
  "rs",
  "ts",
  "tsx",
  "js",
  "mjs",
  "cjs",
  "mts",
  "sh",
  "py",
  "css",
]);

/** Trees that are third-party output or generated project scaffolding. */
const SKIP_PREFIXES = ["mobile/ios/", "mobile/android/"];

function isPrivate(path) {
  return PRIVATE_PREFIXES.some((p) => path.startsWith(p));
}

function commentStyle(path) {
  const ext = path.slice(path.lastIndexOf(".") + 1);
  if (ext === "css") return { open: "/*", line: " *", close: " */" };
  if (ext === "sh" || ext === "py") return { open: null, line: "#", close: null };
  return { open: null, line: "//", close: null };
}

function headerLines(path) {
  const style = commentStyle(path);
  const copyright = `Copyright (c) ${FIRST_YEAR}-${YEAR} ${OWNER}.`;
  const terms = isPrivate(path) ? PRIVATE_TERMS : PUBLIC_TERMS;
  const body = [copyright, terms].map((t) => `${style.line} ${t}`);
  if (style.open) return [style.open, ...body, style.close];
  return body;
}

/** Match an existing header regardless of which year range it was written with. */
const COPYRIGHT_RE = new RegExp(
  `Copyright \\(c\\) ${FIRST_YEAR}-\\d{4} ${OWNER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.`,
);

/**
 * Split a file into (shebang line or null, existing header block or null, rest).
 * The header block is the leading run of comment lines that contains the
 * copyright line; anything else at the top of the file is content.
 */
function parse(path, text) {
  const lines = text.split("\n");
  let i = 0;
  let shebang = null;
  if (lines[0]?.startsWith("#!")) {
    shebang = lines[0];
    i = 1;
  }
  const style = commentStyle(path);
  const start = i;
  if (style.open) {
    if (lines[i]?.trim() === style.open) {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== style.close.trim()) j++;
      if (j < lines.length) {
        const block = lines.slice(i, j + 1);
        if (block.some((l) => COPYRIGHT_RE.test(l))) {
          return { shebang, header: block, rest: lines.slice(j + 1), start };
        }
      }
    }
    return { shebang, header: null, rest: lines.slice(i), start };
  }
  let j = i;
  while (j < lines.length && lines[j].startsWith(style.line + " ")) j++;
  const block = lines.slice(i, j);
  // Only a block that begins with the copyright line is ours; a module doc
  // comment or a license banner from elsewhere is content and stays put.
  if (block.length && COPYRIGHT_RE.test(block[0])) {
    return { shebang, header: block, rest: lines.slice(j), start };
  }
  return { shebang, header: null, rest: lines.slice(i), start };
}

function expectedHeader(path, existing) {
  const wanted = headerLines(path);
  if (!existing) return { ok: false, wanted };
  // Accept any year range already written; only the owner and terms must match.
  const normalise = (ls) => ls.map((l) => l.replace(/\d{4}-\d{4}/, "YEARS")).join("\n");
  return { ok: normalise(existing) === normalise(wanted), wanted };
}

function render(path, parsed, wanted) {
  const out = [];
  if (parsed.shebang) out.push(parsed.shebang);
  out.push(...wanted);
  let rest = parsed.rest;
  // One blank line between the header and the first line of content.
  while (rest.length && rest[0].trim() === "") rest = rest.slice(1);
  if (rest.length) out.push("");
  out.push(...rest);
  let text = out.join("\n");
  if (!text.endsWith("\n")) text += "\n";
  return text;
}

function trackedSourceFiles() {
  const list = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  return list.filter((p) => {
    const ext = p.slice(p.lastIndexOf(".") + 1);
    if (!EXTENSIONS.has(ext)) return false;
    if (SKIP_PREFIXES.some((s) => p.startsWith(s))) return false;
    return true;
  });
}

function main() {
  const fix = process.argv.includes("--fix");
  const wrong = [];
  let fixed = 0;
  for (const path of trackedSourceFiles()) {
    const text = readFileSync(path, "utf8");
    const parsed = parse(path, text);
    const { ok, wanted } = expectedHeader(path, parsed.header);
    if (ok) continue;
    if (fix) {
      writeFileSync(path, render(path, parsed, wanted));
      fixed++;
    } else {
      wrong.push(`${path}${parsed.header ? " (wrong header)" : " (missing header)"}`);
    }
  }
  if (fix) {
    console.log(`headers: ${fixed} file(s) written`);
    return;
  }
  if (wrong.length) {
    console.error(
      "Files without the required copyright header:\n  " + wrong.join("\n  "),
    );
    console.error("\nRun: node scripts/check-headers.mjs --fix");
    process.exit(1);
  }
  console.log("headers: all files ok");
}

main();
