// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Read the fields out of a block of selected text.
 *
 * The person selected this text and asked for it to become a secret, so every
 * key and value line in it is a field: "Project Region: eu-central-1" belongs
 * in the block as much as "Password: ..." does. Judging which keys look
 * sensitive is not this module's job; the dialog lets the person untick a line.
 *
 * Supported shapes:
 * - ASCII box tables:    │ KEY │ VALUE │
 * - Markdown tables:     | KEY | VALUE |
 * - Colon-separated:     Username: admin
 * - Env file style:      DB_PASSWORD=mypassword
 * - Slash-separated:     admin@site.com / Pass123!
 */

export interface DetectedCredential {
  key: string;
  value: string;
  source: "table" | "colon" | "equals" | "slash" | "markdown-table";
  /** Index of the line in the selection this field was read from. */
  line: number;
}

/** One line of the selection, with its position kept through filtering. */
interface Line {
  text: string;
  index: number;
}

/** List markers a line may carry in front of its key. */
const LIST_MARKER = /^(?:[-*•+]|\d+[.)])\s+/;

/**
 * Whether the text before a colon or equals sign reads as a field name: short,
 * on one line, not a sentence. A selection can hold prose; "Note: call the bank
 * tomorrow." would make a field called "Note", and the person can untick it,
 * but a paragraph that happens to contain a colon should not.
 */
function looksLikeFieldKey(key: string): boolean {
  if (key.length === 0 || key.length > 64) return false;
  if (/[.!?]$/.test(key)) return false;
  if (/^[#>|`]/.test(key)) return false;
  // Real keys run to three or four words ("AWS Root Account ID"); a sentence
  // fragment runs longer.
  return key.split(/\s+/).length <= 4;
}

/** Lines that are ASCII table borders (box-drawing characters). */
function isTableBorder(line: string): boolean {
  const t = line.trim();
  return /^[┌┐└┘├┤┬┴┼─│╭╮╰╯═╔╗╚╝╠╣╦╩╬\-+|=\s]+$/.test(t);
}

/** Lines that are markdown table separators. */
function isMarkdownSeparator(line: string): boolean {
  return /^\|[\s:|-]+\|$/.test(line.trim());
}

/** Common header labels to skip. */
function isHeaderValue(val: string): boolean {
  const lower = val.toLowerCase().trim();
  return [
    "key",
    "value",
    "name",
    "setting",
    "parameter",
    "field",
    "description",
    "",
  ].includes(lower);
}

/** Parse ASCII box table rows (│ Key │ Value │). */
function parseBoxTable(lines: Line[]): DetectedCredential[] {
  const results: DetectedCredential[] = [];
  let skippedHeader = false;

  for (const { text: line, index } of lines) {
    if (isTableBorder(line)) continue;
    // Check for box-drawing │
    if (!line.includes("│")) continue;

    const cells = line
      .split("│")
      .map((c) => c.trim())
      .filter((c) => c.length > 0);

    if (cells.length >= 2) {
      const key = cells[0] ?? "";
      const value = cells[1] ?? "";

      // Skip header row
      if (!skippedHeader && isHeaderValue(value)) {
        skippedHeader = true;
        continue;
      }

      if (key && value) {
        results.push({ key, value, source: "table", line: index });
      }
    }
  }
  return results;
}

/** Parse markdown table rows (| Key | Value |). */
function parseMarkdownTable(lines: Line[]): DetectedCredential[] {
  const results: DetectedCredential[] = [];
  let skippedHeader = false;

  for (const { text: line, index } of lines) {
    if (isMarkdownSeparator(line)) continue;
    const t = line.trim();
    if (!t.startsWith("|") || !t.endsWith("|")) continue;

    const cells = t
      .slice(1, -1)
      .split("|")
      .map((c) => c.trim());

    if (cells.length >= 2) {
      const key = cells[0] ?? "";
      const value = cells[1] ?? "";

      if (!skippedHeader && isHeaderValue(value)) {
        skippedHeader = true;
        continue;
      }

      if (key && value) {
        results.push({ key, value, source: "markdown-table", line: index });
      }
    }
  }
  return results;
}

/** Parse Key: Value lines. */
function parseColonLines(lines: Line[]): DetectedCredential[] {
  const results: DetectedCredential[] = [];
  for (const { text: line, index } of lines) {
    const t = line.trim().replace(LIST_MARKER, "");
    if (!t || isTableBorder(t)) continue;
    const colonIdx = t.indexOf(": ");
    if (colonIdx <= 0) continue;

    const key = t.slice(0, colonIdx).trim();
    const value = t.slice(colonIdx + 2).trim();

    if (value && looksLikeFieldKey(key)) {
      results.push({ key, value, source: "colon", line: index });
    }
  }
  return results;
}

/** Parse KEY=value lines (env file style, any case). */
function parseEqualsLines(lines: Line[]): DetectedCredential[] {
  const results: DetectedCredential[] = [];
  for (const { text: line, index } of lines) {
    const t = line.trim().replace(LIST_MARKER, "");
    if (!t || t.startsWith("#")) continue;
    const eqIdx = t.indexOf("=");
    if (eqIdx <= 0) continue;

    const key = t.slice(0, eqIdx).trim();
    const value = t.slice(eqIdx + 1).trim();

    if (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key) && value) {
      results.push({ key, value, source: "equals", line: index });
    }
  }
  return results;
}

/** Parse username / password lines. */
function parseSlashLines(lines: Line[]): DetectedCredential[] {
  const results: DetectedCredential[] = [];
  for (const { text: line, index } of lines) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split(/\s+\/\s+/);
    if (parts.length !== 2) continue;

    const left = (parts[0] ?? "").trim();
    const right = (parts[1] ?? "").trim();

    // Left should look like a username or email
    if (left && right && (left.includes("@") || /^[a-zA-Z][\w.-]+$/.test(left))) {
      results.push({
        key: left.includes("@") ? "Email" : "Username",
        value: left,
        source: "slash",
        line: index,
      });
      results.push({ key: "Password", value: right, source: "slash", line: index });
    }
  }
  return results;
}

/**
 * Detect credentials in the given text.
 * Tries each pattern and returns all detected credentials.
 * Deduplicates by key+value.
 */
export function detectCredentials(text: string): DetectedCredential[] {
  const lines: Line[] = text.split("\n").map((t, index) => ({ text: t, index }));

  // Try table patterns first (most structured)
  const hasBoxChars = text.includes("│");
  const hasMarkdownTable = lines.some(
    (l) => l.text.trim().startsWith("|") && l.text.trim().endsWith("|"),
  );

  const results: DetectedCredential[] = [];

  if (hasBoxChars) {
    results.push(...parseBoxTable(lines));
  }
  if (hasMarkdownTable) {
    results.push(...parseMarkdownTable(lines));
  }

  // Try line-based patterns on non-table lines
  const nonTableLines = lines.filter(
    (l) =>
      !l.text.includes("│") && !isTableBorder(l.text) && !isMarkdownSeparator(l.text),
  );
  results.push(...parseColonLines(nonTableLines));
  results.push(...parseEqualsLines(nonTableLines));
  results.push(...parseSlashLines(nonTableLines));

  // Deduplicate by key+value
  const seen = new Set<string>();
  return results.filter((c) => {
    const key = `${c.key}::${c.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Generate secret block(s) from detected credentials.
 *
 * @param credentials - The detected credentials
 * @param label - Label for the secret block (used in "one" mode)
 * @param mode - "one" = single secret with multiple fields, "separate" = one secret per credential
 */
export function generateSecretBlocks(
  credentials: DetectedCredential[],
  label: string,
  mode: "one" | "separate",
): string {
  if (credentials.length === 0) return "";

  if (mode === "one") {
    const fields = credentials.map((c) => `${c.key}: ${c.value}`).join("\n");
    return `:::secret[${escapeLabel(label)}]\n${fields}\n:::\n`;
  }

  // Separate mode: one secret per credential (or per group for slash-detected pairs)
  return credentials
    .map((c) => {
      const secretLabel = c.source === "slash" ? label || c.key : c.key;
      return `:::secret[${escapeLabel(secretLabel)}]\n${c.key}: ${c.value}\n:::\n`;
    })
    .join("\n");
}

/** A line that belongs to a table: a row, a border or a separator. */
function isTableLine(line: string): boolean {
  const t = line.trim();
  return (
    t.includes("│") ||
    isTableBorder(t) ||
    isMarkdownSeparator(t) ||
    (t.startsWith("|") && t.endsWith("|"))
  );
}

/**
 * The text that replaces the selection once some of its fields are converted.
 *
 * Only the lines the converted fields were read from are removed; every other
 * line of the selection stays exactly as it was, in its place, so nothing the
 * person did not ask to move is lost. The secret block goes where the first
 * converted line stood. A table whose rows were all converted goes entirely,
 * frame included; a table with rows left keeps its frame. A line that carries
 * two fields ("user / pass") is removed only when both were converted.
 */
export function applyConversion(
  selectedText: string,
  converted: DetectedCredential[],
  secretBlocks: string,
): string {
  const lines = selectedText.split("\n");
  const all = detectCredentials(selectedText);
  const convertedKeys = new Set(converted.map((c) => `${c.key}::${c.value}`));
  const removed = new Set<number>();
  for (const line of new Set(all.map((c) => c.line))) {
    const onLine = all.filter((c) => c.line === line);
    if (onLine.every((c) => convertedKeys.has(`${c.key}::${c.value}`))) removed.add(line);
  }
  if (converted.length === 0) return selectedText;

  // A table's frame follows its rows: gone when they are all gone.
  const dataRows = new Set(all.map((c) => c.line));
  let i = 0;
  while (i < lines.length) {
    if (!isTableLine(lines[i] ?? "")) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < lines.length && isTableLine(lines[j] ?? "")) j += 1;
    const rows = [];
    for (let k = i; k < j; k += 1) if (dataRows.has(k)) rows.push(k);
    if (rows.length > 0 && rows.every((k) => removed.has(k))) {
      for (let k = i; k < j; k += 1) removed.add(k);
    }
    i = j;
  }

  // The block stands where the first converted field was, even when that
  // line stays because its other field was not converted.
  const first = Math.min(...converted.map((c) => c.line));
  const out: string[] = [];
  for (let k = 0; k < lines.length; k += 1) {
    if (k === first) out.push(secretBlocks.replace(/\n$/, ""));
    if (!removed.has(k)) out.push(lines[k] ?? "");
  }
  return out.join("\n");
}

/** Escape ] in labels to \] for the :::secret[Label] syntax. */
function escapeLabel(label: string): string {
  return label.replace(/]/g, "\\]");
}
