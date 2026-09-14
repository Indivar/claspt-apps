// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Strip secret block values from markdown content before it is persisted to
 * localStorage (crash-recovery drafts) or rendered into a commit diff. The
 * `:::secret[Label]` fence structure is kept; the body is replaced with a
 * `[REDACTED]` placeholder so a live value never reaches unencrypted browser
 * storage.
 *
 *   :::secret[Label]          :::secret[Label]
 *   SOME_VALUE          ->    [REDACTED]
 *   (more lines)              :::
 *   :::
 *
 * This runs on every keystroke in the editor, BEFORE the content has been
 * encrypted, so a miss here writes a real secret into storage that outlives
 * vault lock. It is therefore written to over-redact rather than under-redact:
 * every rule below resolves ambiguity in favour of removing more.
 *
 * A line-by-line scan replaces the regex this used to be. The pattern had four
 * ways to miss a block entirely — an escaped `]` in the label, CRLF line
 * endings, an indented closing fence, and a block still being typed that had no
 * closing fence yet — and in each case left the full body in the draft.
 */

/** Opening fence of the Rust encryptor, matched on the trimmed line. */
const OPEN_FENCE = ":::secret[";

/** Closing fence, which Rust also compares against the trimmed line. */
const CLOSE_FENCE = ":::";

/**
 * True if this line starts a secret block.
 *
 * Deliberately only checks the prefix. Rust additionally requires an unescaped
 * `]` to parse the label, and skips blocks inside markdown code fences — but
 * both of those mean the block is NOT encrypted on disk, so its body is real
 * cleartext sitting in the buffer. Those are the cases that most need redacting,
 * not the ones to exempt.
 */
function opensSecretBlock(line: string): boolean {
  return line.trim().startsWith(OPEN_FENCE);
}

/** True if this line closes a secret block. Trimmed, matching the Rust parser. */
function closesSecretBlock(line: string): boolean {
  return line.trim() === CLOSE_FENCE;
}

export function stripSecretValues(content: string): string {
  const out: string[] = [];
  let insideBlock = false;

  // Splitting on "\n" leaves any "\r" attached to the end of each line, so CRLF
  // input rejoins unchanged and the trim() inside the predicates still matches.
  for (const line of content.split("\n")) {
    if (insideBlock) {
      // Body lines are dropped, not copied, so nothing from inside a block can
      // reach the output by any path.
      if (closesSecretBlock(line)) {
        out.push("[REDACTED]", line);
        insideBlock = false;
      }
      continue;
    }

    out.push(line);
    if (opensSecretBlock(line)) insideBlock = true;
  }

  // A block still being typed has no closing fence yet — which is exactly when
  // drafts are written. Its body has already been dropped above; mark that
  // something was removed rather than truncating silently.
  if (insideBlock) out.push("[REDACTED]");

  return out.join("\n");
}
