// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Detect credential patterns in selected text and extract key-value pairs.
 *
 * Supported patterns:
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
}

/** Common credential-related key names (lowercase for matching). */
const CREDENTIAL_KEYS = new Set([
  "url",
  "uri",
  "site",
  "website",
  "domain",
  "host",
  "server",
  "port",
  "username",
  "user",
  "login",
  "email",
  "e-mail",
  "password",
  "pass",
  "passwd",
  "secret",
  "token",
  "api_key",
  "api key",
  "apikey",
  "access_key",
  "access key",
  "secret_key",
  "secret key",
  "private_key",
  "private key",
  "public_key",
  "public key",
  "ssh_key",
  "ssh key",
  "key",
  "pin",
  "code",
  "otp",
  "2fa",
  "totp",
  "recovery",
  "backup",
  "account",
  "name",
  "phone",
  "address",
  "database",
  "db",
  "connection",
  "endpoint",
  "bucket",
  "region",
  "webhook",
]);

/** Check if a key name looks like a credential field. */
function isCredentialKey(key: string): boolean {
  const lower = key.toLowerCase().trim();
  if (CREDENTIAL_KEYS.has(lower)) return true;
  // UPPER_SNAKE_CASE keys (env vars) are likely credentials
  if (/^[A-Z][A-Z0-9_]{2,}$/.test(key.trim())) return true;
  // Keys containing common credential words
  for (const word of [
    "key",
    "secret",
    "token",
    "password",
    "pass",
    "auth",
    "credential",
    "api",
    "stripe",
    "aws",
  ]) {
    if (lower.includes(word)) return true;
  }
  return false;
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
function parseBoxTable(lines: string[]): DetectedCredential[] {
  const results: DetectedCredential[] = [];
  let skippedHeader = false;

  for (const line of lines) {
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
        results.push({ key, value, source: "table" });
      }
    }
  }
  return results;
}

/** Parse markdown table rows (| Key | Value |). */
function parseMarkdownTable(lines: string[]): DetectedCredential[] {
  const results: DetectedCredential[] = [];
  let skippedHeader = false;

  for (const line of lines) {
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
        results.push({ key, value, source: "markdown-table" });
      }
    }
  }
  return results;
}

/** Parse Key: Value lines. */
function parseColonLines(lines: string[]): DetectedCredential[] {
  const results: DetectedCredential[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t || isTableBorder(t)) continue;
    const colonIdx = t.indexOf(": ");
    if (colonIdx <= 0) continue;

    const key = t.slice(0, colonIdx).trim();
    const value = t.slice(colonIdx + 2).trim();

    if (key && value && isCredentialKey(key)) {
      results.push({ key, value, source: "colon" });
    }
  }
  return results;
}

/** Parse KEY=value lines (env file style). */
function parseEqualsLines(lines: string[]): DetectedCredential[] {
  const results: DetectedCredential[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eqIdx = t.indexOf("=");
    if (eqIdx <= 0) continue;

    const key = t.slice(0, eqIdx).trim();
    const value = t.slice(eqIdx + 1).trim();

    // Only match UPPER_SNAKE_CASE keys
    if (/^[A-Z][A-Z0-9_]{2,}$/.test(key) && value) {
      results.push({ key, value, source: "equals" });
    }
  }
  return results;
}

/** Parse username / password lines. */
function parseSlashLines(lines: string[]): DetectedCredential[] {
  const results: DetectedCredential[] = [];
  for (const line of lines) {
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
      });
      results.push({ key: "Password", value: right, source: "slash" });
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
  const lines = text.split("\n");

  // Try table patterns first (most structured)
  const hasBoxChars = text.includes("│");
  const hasMarkdownTable = lines.some(
    (l) => l.trim().startsWith("|") && l.trim().endsWith("|"),
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
    (l) => !l.includes("│") && !isTableBorder(l) && !isMarkdownSeparator(l),
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

/** Escape ] in labels to \] for the :::secret[Label] syntax. */
function escapeLabel(label: string): string {
  return label.replace(/]/g, "\\]");
}
