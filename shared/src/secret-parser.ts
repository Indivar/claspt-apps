// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Parse `:::secret[Label]` blocks out of decrypted page content.
 *
 * This is the browser-side twin of `crates/claspt-core/src/pages/secret.rs`.
 * The two MUST agree on what counts as a secret block, because the desktop
 * decides what to encrypt and the extension decides what to offer for fill.
 * Where they disagree, a credential either vanishes from the extension or the
 * extension offers something the desktop never treated as a secret.
 *
 * The rules, matching the Rust scanner line for line:
 *
 *   - A block opens on a line whose trimmed form starts with `:::secret[`.
 *   - Inside the label, `]` terminates only when preceded by an EVEN number of
 *     backslashes; `\]` and `\\` are unescaped in the returned label.
 *   - A block closes on a line whose trimmed form is exactly `:::`.
 *   - A block that never closes is not a block.
 *   - `:::secret` inside a fenced code block (``` or ~~~) is a markdown example
 *     and is skipped.
 *
 * The previous implementation was a single regex,
 * `/:::secret\[([^\]]*)\]\s*\n([\s\S]*?):::/g`, which broke all four of those:
 * it could not read an escaped label at all (so a credential labelled
 * `mongodb.com[2]` disappeared from the extension entirely), it matched `:::`
 * mid-line, and it happily parsed examples inside code fences.
 */

/** Reverse the desktop's `escape_label`. */
export function unescapeLabel(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    // Only `\\` and `\]` are escape sequences. A backslash before anything else
    // is literal — builds before 3.0.11 escaped `]` but never `\`, so labels
    // like `C:\Users\me` were written raw and must still read back unchanged.
    if (c === "\\" && (raw[i + 1] === "\\" || raw[i + 1] === "]")) {
      out += raw[i + 1];
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * If this line opens a secret block, return its (unescaped) label.
 *
 * `:::secret[mongodb.com[2\]]` -> `mongodb.com[2]`
 */
export function parseSecretOpen(line: string): string | null {
  const trimmed = line.trim();
  const OPEN = ":::secret[";
  if (!trimmed.startsWith(OPEN)) return null;
  const afterBracket = trimmed.slice(OPEN.length);

  // Count the backslash run before each `]`: an odd run means the bracket is
  // escaped and does not terminate the label. Counting the run rather than
  // looking one character back is what lets a label end in a backslash.
  for (let i = 0; i < afterBracket.length; i++) {
    if (afterBracket[i] !== "]") continue;
    let backslashes = 0;
    for (let j = i - 1; j >= 0 && afterBracket[j] === "\\"; j--) backslashes++;
    if (backslashes % 2 === 0) {
      return unescapeLabel(afterBracket.slice(0, i));
    }
  }
  return null;
}

/** True when the line opens or closes a markdown fenced code block. */
function isCodeFence(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("```") || trimmed.startsWith("~~~");
}

/**
 * Parse `key: value` pairs from a decrypted secret block body.
 *
 * Splits on the FIRST colon, matching every field parser on the desktop
 * (`split_once(':')`). Requiring a following space, as this used to, silently
 * dropped any field written as `password:hunter2`.
 */
export function parseSecretFields(body: string): Record<string, string> {
  const fields: Record<string, string> = {};

  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx <= 0) continue;

    const key = trimmed.slice(0, colonIdx).trim().toLowerCase();
    const value = trimmed.slice(colonIdx + 1).trim();
    if (key && value) {
      fields[key] = value;
    }
  }

  return fields;
}

/**
 * Extract every secret block from page content.
 */
export function extractSecretBlocks(
  content: string
): Array<{ label: string; body: string; fields: Record<string, string> }> {
  const blocks: Array<{ label: string; body: string; fields: Record<string, string> }> = [];
  const lines = content.split("\n");

  let inCodeFence = false;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (isCodeFence(line)) {
      inCodeFence = !inCodeFence;
      i++;
      continue;
    }

    const label = inCodeFence ? null : parseSecretOpen(line);
    if (label === null) {
      i++;
      continue;
    }

    // Collect until a line that is exactly `:::`.
    const bodyLines: string[] = [];
    let closed = false;
    i++;
    while (i < lines.length) {
      const inner = lines[i] ?? "";
      if (inner.trim() === ":::") {
        closed = true;
        i++;
        break;
      }
      bodyLines.push(inner);
      i++;
    }

    // An unterminated block is not a block — same as the desktop, which leaves
    // the collected text alone rather than encrypting it.
    if (!closed) continue;

    const body = bodyLines.join("\n");
    blocks.push({ label, body: body.trim(), fields: parseSecretFields(body) });
  }

  return blocks;
}
