// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Regenerate `src/shared/public-suffix-data.ts` from the Public Suffix List.
 *
 * Usage:
 *   node scripts/generate-psl.mjs                  # fetch the current list
 *   node scripts/generate-psl.mjs path/to/list.dat # use a local copy
 *
 * WHY WE ONLY KEEP MULTI-LABEL RULES
 * ----------------------------------
 * The PSL has ~10,300 rules, ~1,400 of which are a single label (`com`, `uk`,
 * `jp`). A single-label rule always yields "the last two labels" as the
 * registrable domain, which is exactly what `getRegistrableDomain` falls back
 * to when no rule matches. The PSL also specifies that an unlisted TLD is
 * treated as if the rule `*` matched, which gives the same answer again. So
 * dropping single-label rules cannot change any result, and it keeps the table
 * that ships inside every content script down to ~135 KB.
 *
 * Wildcard (`*.ck`) and exception (`!www.ck`) rules always contain a dot, so
 * they survive the filter.
 *
 * IDN rules are stored in punycode because `new URL(...).hostname` is always
 * punycode-encoded, and the lookup compares the two directly.
 */

import { writeFileSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { domainToASCII } from "node:url";

const PSL_URL = "https://publicsuffix.org/list/public_suffix_list.dat";
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../src/shared/public-suffix-data.ts");

/** Convert any non-ASCII labels in a rule to punycode, preserving `*` and `!`. */
function toAscii(rule) {
  const negated = rule.startsWith("!");
  const body = negated ? rule.slice(1) : rule;
  const labels = body.split(".").map((label) => {
    if (label === "*" || /^[a-z0-9-]*$/.test(label)) return label;
    const ascii = domainToASCII(label);
    if (!ascii) throw new Error(`cannot punycode label "${label}" in rule "${rule}"`);
    return ascii;
  });
  return (negated ? "!" : "") + labels.join(".");
}

async function loadList() {
  const localPath = process.argv[2];
  if (localPath) return readFileSync(localPath, "utf8");
  const res = await fetch(PSL_URL);
  if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
  return res.text();
}

const raw = await loadList();

const rules = [];
for (const line of raw.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("//")) continue;
  const rule = toAscii(trimmed.toLowerCase());
  // Single-label rules are redundant — see the note at the top of this file.
  if (!rule.includes(".")) continue;
  rules.push(rule);
}

if (rules.length < 5000) {
  throw new Error(`only ${rules.length} rules parsed — the list looks truncated, refusing to write`);
}

const sorted = [...new Set(rules)].sort();
const generatedOn = new Date().toISOString().slice(0, 10);

// The generated file gets the same copyright header as every other source
// file (scripts/check-headers.mjs checks for it), placed before the
// generation notice so regenerating never removes it.
const header = `// Copyright (c) 2025-${new Date().getFullYear()} Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Public Suffix List rules, multi-label subset.
 *
 * GENERATED FILE — do not edit by hand. Regenerate with:
 *   npm run psl:update
 *
 * Source:    ${PSL_URL}
 * Retrieved: ${generatedOn}
 * Rules:     ${sorted.length}
 *
 * Single-label rules are deliberately omitted; see scripts/generate-psl.mjs
 * for why that cannot change any lookup result. Stored as one newline-joined
 * string so the parse cost is a single split on first use rather than a
 * ${sorted.length}-element array literal the JS engine has to build eagerly.
 */

/** ISO date the list was retrieved, surfaced in tests so staleness is visible. */
export const PUBLIC_SUFFIX_LIST_DATE = "${generatedOn}";

/** Newline-joined PSL rules. Parsed by \`shared/url-matching.ts\`. */
export const PUBLIC_SUFFIX_RULES = \`${sorted.join("\n")}\`;
`;

writeFileSync(OUT, header, "utf8");
console.log(`wrote ${OUT}: ${sorted.length} rules, ${(header.length / 1024).toFixed(0)} KB`);
