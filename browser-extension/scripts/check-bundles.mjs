// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Refuses to package a build that can set HTML from a value.
 *
 * Runs after the build and before the zip. It reads every script in dist and
 * fails on an innerHTML or outerHTML assignment whose right-hand side is not a
 * string literal, on insertAdjacentHTML, and on document.write. A literal
 * cannot carry anything from a page or a vault, which is also where Mozilla's
 * validator draws its line. This is the second, independent guard behind
 * scripts/no-html-injection.mjs: that one edits React DOM on the way in, this
 * one reads what actually came out.
 *
 *   node scripts/check-bundles.mjs [dist]
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** An assignment to innerHTML or outerHTML; what follows decides. */
const HTML_ASSIGNMENT = /\.(innerHTML|outerHTML)\s*=(?!=)/g;

/** One complete quoted string, then the end of the expression. Only that is
 *  a literal: "<svg>" + value is a value. */
const LITERAL_TO_THE_END = /^\s*(["'])(?:\\.|(?!\1)[^\\\n])*\1\s*[;,)}\n]/;

const OTHER_SINKS = [
  { name: "insertAdjacentHTML", re: /\.insertAdjacentHTML\s*\(/g },
  { name: "document.write", re: /document\.write(ln)?\s*\(/g },
];

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

/**
 * @param {string} text A built script.
 * @returns {{ name: string; line: number }[]} What it must not contain.
 */
export function findHtmlInjection(text) {
  const found = [];
  for (const match of text.matchAll(HTML_ASSIGNMENT)) {
    const rest = text.slice(match.index + match[0].length);
    // A literal cannot carry anything from a page or a vault, which is also
    // where Mozilla's validator draws its line.
    if (LITERAL_TO_THE_END.test(rest)) continue;
    found.push({
      name: "innerHTML or outerHTML assigned from a value",
      line: lineOf(text, match.index),
    });
  }
  for (const sink of OTHER_SINKS) {
    for (const match of text.matchAll(sink.re)) {
      found.push({ name: sink.name, line: lineOf(text, match.index) });
    }
  }
  return found;
}

function scripts(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...scripts(path));
    else if (path.endsWith(".js")) out.push(path);
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const dist = resolve(root, process.argv[2] ?? "dist");
  let failures = 0;
  for (const file of scripts(dist)) {
    for (const hit of findHtmlInjection(readFileSync(file, "utf8"))) {
      console.error(`${relative(root, file)}:${hit.line}: ${hit.name}`);
      failures += 1;
    }
  }
  if (failures > 0) {
    console.error(
      `check-bundles: ${failures} place(s) can set HTML from a value; not packaging.`,
    );
    process.exit(1);
  }
  console.log("check-bundles: no HTML injection in the built scripts");
}
