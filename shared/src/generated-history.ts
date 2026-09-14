// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Shape of the generated-password history stored in the vault.
 *
 * Every password Claspt generates is written to the vault as its own secret
 * block, so it is encrypted at rest, survives a lock, a browser restart and a
 * reinstall, and syncs to the user's other devices. It previously lived in
 * `chrome.storage.session`, which is wiped on browser close AND on vault lock,
 * and was only written on copy-or-use rather than on generation — so a password
 * generated, pasted into a site and then locked away was simply gone.
 *
 * Browser storage cannot hold these: `session` loses them, and `local` would
 * put every generated password on disk in cleartext. The vault is the only
 * place that is both durable and encrypted.
 *
 * Layout — one folder, one page per month, one block per password:
 *
 *   Generated password history/
 *     2026-09.md
 *       :::secret[accounts.google.com — 4 Sep 16:43:07]
 *       password: <value>
 *       site: accounts.google.com
 *       source: browser extension
 *       used: yes
 *       generated: 2026-09-04T16:43:07.123Z
 *       url_match: never
 *       :::
 *
 * A block per password rather than one table per page: the block is the unit
 * the encryption, the API and the desktop UI all work in, so each entry gets
 * its own reveal and copy control, an append re-encrypts one entry instead of
 * the month, and a corrupted blob costs one password rather than all of them.
 *
 * Monthly rather than daily: a heavy user generates tens per month, which keeps
 * pages small without producing 365 near-empty pages a year. The site lives in
 * the label, and labels stay plaintext and indexed, so searching for a site
 * finds its generated passwords across every month.
 */

import { extractSecretBlocks } from "./secret-parser";

/** Vault folder holding the history pages. */
export const HISTORY_FOLDER = "Generated password history";

/** Tag applied to every history page, so they are identifiable by more than title. */
export const HISTORY_TAG = "generated-password-history";

/** Where a password came from. Written into the block, and shown in the list. */
export type GeneratedSource = "browser extension" | "desktop app" | "mobile app";

export interface GeneratedEntry {
  /** The generated value. */
  password: string;
  /** Hostname it was generated on, or empty when generated outside a page. */
  site: string;
  source: GeneratedSource;
  /** True once the user copied it or filled it into a form. */
  used: boolean;
  /** ISO timestamp — the machine-readable half; the label carries the readable one. */
  generated: string;
  /**
   * The credential this was generated for, as `pagePath::label`, when it was
   * generated from inside one. Lets a credential show the passwords generated
   * for it, which is the fastest way back to one that was set and not saved.
   */
  forCredential?: string;
}

/** An entry plus where it lives, so the caller can patch or delete it. */
export interface StoredGeneratedEntry extends GeneratedEntry {
  pagePath: string;
  label: string;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Page title for the month a timestamp falls in: "Generated passwords — September 2026". */
export function monthPageTitle(when: Date): string {
  return `Generated passwords — ${MONTHS[when.getMonth()] ?? ""} ${when.getFullYear()}`;
}

/**
 * Human-readable, unique block label: "accounts.google.com — 4 Sep 16:43:07".
 *
 * Seconds are included because two generations in the same minute for the same
 * site would otherwise share a label, and a patch would merge the second into
 * the first — losing one of exactly the passwords this exists to keep.
 */
export function historyBlockLabel(site: string, when: Date): string {
  const day = when.getDate();
  const month = (MONTHS[when.getMonth()] ?? "").slice(0, 3);
  const hh = String(when.getHours()).padStart(2, "0");
  const mm = String(when.getMinutes()).padStart(2, "0");
  const ss = String(when.getSeconds()).padStart(2, "0");
  const where = site || "no site";
  return `${where} — ${day} ${month} ${hh}:${mm}:${ss}`;
}

/**
 * Fields written into a history block.
 *
 * `url_match: never` is not optional. Without it these entries score as
 * credentials for their own site, so the picker on accounts.google.com would
 * offer a rejected password from last month alongside the real login.
 */
export function historyBlockFields(entry: GeneratedEntry): Record<string, string> {
  const fields: Record<string, string> = {
    password: entry.password,
    site: entry.site || "—",
    source: entry.source,
    used: entry.used ? "yes" : "no",
    generated: entry.generated,
    url_match: "never",
  };
  if (entry.forCredential) fields["for"] = entry.forCredential;
  return fields;
}

/** Recognised source values, falling back to the extension for older entries. */
function readSource(raw: string | undefined): GeneratedSource {
  if (raw === "desktop app" || raw === "mobile app") return raw;
  return "browser extension";
}

/** Read a history block back into an entry. Returns null if it is not one. */
export function parseHistoryBlock(
  pagePath: string,
  label: string,
  fields: Record<string, string>,
): StoredGeneratedEntry | null {
  const password = fields["password"];
  const generated = fields["generated"];
  if (!password || !generated) return null;

  const site = fields["site"] && fields["site"] !== "—" ? fields["site"] : "";
  return {
    pagePath,
    label,
    password,
    site,
    source: readSource(fields["source"]),
    used: (fields["used"] ?? "").toLowerCase() === "yes",
    generated,
    forCredential: fields["for"] || undefined,
  };
}

/** Build the `for` value identifying a credential. */
export function credentialRef(pagePath: string, label: string): string {
  return `${pagePath}::${label}`;
}

/**
 * The non-secret text at the top of a month page.
 *
 * It sits outside every secret block, so it must never contain a value. It is
 * there because someone opening this page in a plain markdown editor — which
 * the vault format is designed to allow — should be able to tell what wrote it
 * and what is safe to delete.
 */
export function monthPageIntro(when: Date): string {
  return [
    `# ${monthPageTitle(when)}`,
    "",
    "Passwords generated by Claspt this month, from the desktop app and the",
    "browser extension. Claspt writes this page automatically.",
    "",
    "`used: yes` means the password was copied or filled into a site. The rest",
    "were generated and not taken up, and are the ones the \"Clear unused",
    "passwords\" button removes.",
    "",
    "Each password is encrypted. The labels, dates and site names are not, so",
    "the page stays searchable.",
    "",
  ].join("\n");
}

/** Entries the "Clear unused passwords" action would remove. */
export function unusedEntriesOlderThan(
  entries: StoredGeneratedEntry[],
  days: number,
  now: number = Date.now(),
): StoredGeneratedEntry[] {
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  return entries.filter((e) => {
    if (e.used) return false;
    const at = Date.parse(e.generated);
    return Number.isFinite(at) && at < cutoff;
  });
}

/** Newest first. */
export function sortNewestFirst(entries: StoredGeneratedEntry[]): StoredGeneratedEntry[] {
  return [...entries].sort((a, b) => Date.parse(b.generated) - Date.parse(a.generated));
}

// ── Writing a block ───────────────────────────────────────────────────
//
// The extension patches blocks through the local API, which does its own
// escaping. The desktop app appends to page markdown directly, so the fence
// text is built here — in the same file as the layout it has to match.

/**
 * Escape a label for writing into a `:::secret[...]` fence.
 *
 * The backslash MUST be escaped before the bracket, matching
 * `crates/claspt-core/src/pages/secret.rs`. Escaping only `]` writes a label
 * ending in a backslash as `...\]`, which reads back as an escaped bracket,
 * finds no terminator, and drops the whole block — and a dropped block on the
 * encryption path is a value written to disk in plaintext.
 */
export function escapeSecretLabel(label: string): string {
  return label.replace(/\\/g, "\\\\").replace(/]/g, "\\]");
}

/**
 * Render one history entry as a complete secret block.
 *
 * Field values are written verbatim, so any newline in one would break out of
 * the fence. Generated passwords and hostnames contain none, and the desktop
 * rejects fence-breaking input on the way in, but the guard is here too because
 * this function is what actually writes the file.
 */
export function renderHistoryBlock(entry: GeneratedEntry, when: Date): string {
  const fields = historyBlockFields(entry);
  const lines = [`:::secret[${escapeSecretLabel(historyBlockLabel(entry.site, when))}]`];
  for (const [key, value] of Object.entries(fields)) {
    lines.push(`${key}: ${value.replace(/[\r\n]+/g, " ")}`);
  }
  lines.push(":::");
  return lines.join("\n");
}

// ── Block text editing ────────────────────────────────────────────────
//
// Line-based, matching the scanner in ./secret-parser.ts: a block opens on a
// line whose trimmed form starts the fence and closes on a line that is exactly
// `:::`. Both the desktop app and the mobile app edit history pages this way —
// neither exposes a block-level patch to its UI layer — so the operations live
// here rather than once per app.

function blockRange(content: string, label: string): { start: number; end: number } | null {
  const lines = content.split("\n");
  const blocks = extractSecretBlocks(content);
  if (!blocks.some((b) => b.label === label)) return null;

  for (let i = 0; i < lines.length; i++) {
    if (!(lines[i] ?? "").trim().startsWith(":::secret[")) continue;
    const found = extractSecretBlocks(lines.slice(i).join("\n"))[0];
    if (found?.label !== label) continue;
    for (let j = i + 1; j < lines.length; j++) {
      if ((lines[j] ?? "").trim() === ":::") return { start: i, end: j };
    }
    return null;
  }
  return null;
}

/**
 * Set or add one `key: value` line inside the named block.
 *
 * Exported for tests: this and {@link removeBlock} rewrite page markdown in
 * place, so a mistake here silently corrupts a vault page rather than throwing.
 */
export function setFieldInBlock(content: string, label: string, key: string, value: string): string {
  const range = blockRange(content, label);
  if (!range) return content;

  const lines = content.split("\n");
  const prefix = `${key}:`;
  for (let i = range.start + 1; i < range.end; i++) {
    if ((lines[i] ?? "").trim().toLowerCase().startsWith(prefix)) {
      lines[i] = `${key}: ${value}`;
      return lines.join("\n");
    }
  }
  lines.splice(range.end, 0, `${key}: ${value}`);
  return lines.join("\n");
}

/** Remove the named block entirely, including its fences. */
export function removeBlock(content: string, label: string): string {
  const range = blockRange(content, label);
  if (!range) return content;

  const lines = content.split("\n");
  lines.splice(range.start, range.end - range.start + 1);
  // Collapse the blank line the removal leaves behind.
  while (
    range.start > 0 &&
    range.start < lines.length &&
    (lines[range.start] ?? "").trim() === "" &&
    (lines[range.start - 1] ?? "").trim() === ""
  ) {
    lines.splice(range.start, 1);
  }
  return lines.join("\n");
}
