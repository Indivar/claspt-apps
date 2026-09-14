// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Secret-block parsing, encryption, and field-level editing.
//!
//! Claspt notes embed secrets inline using a fenced Markdown syntax so the file
//! stays a portable `.md`. A block looks like this in the editor (decrypted):
//!
//! ```text
//! :::secret[Label]
//! field1: value1
//! field2: value2
//! :::
//! ```
//!
//! **What is and isn't encrypted.** Only the block *body* (the lines between the
//! fences) is encrypted. The `Label` stays plaintext so it remains searchable and
//! the file stays human-readable and portable. On disk the body is replaced with a
//! single sentinel line `enc:v1:<base64-ciphertext>` (see [`ENC_PREFIX`]):
//!
//! ```text
//! :::secret[Label]
//! enc:v1:<base64>
//! :::
//! ```
//!
//! **Encrypt-on-save / decrypt-on-read.** [`encrypt_secrets`] runs on save and
//! turns every plaintext block into the `enc:v1:` form (blocks already encrypted
//! are left untouched, so saving twice is a no-op). [`decrypt_secrets`] runs on
//! read and reverses it. Each block is encrypted independently with the vault
//! master key via [`crate::crypto::vault_key`] (AES-256-GCM, unique nonce per
//! block). A block that fails to decrypt (e.g. copied in from a different vault)
//! is left as raw ciphertext rather than dropped, so a later save cannot clobber
//! it — export variants ([`decrypt_secrets_for_export`],
//! [`decrypt_full_body_for_export`]) instead substitute a visible placeholder so
//! exported files are always portable plaintext.
//!
//! **Full-body encryption.** A whole page can also be encrypted as one blob using
//! the same `enc:v1:` format via [`encrypt_full_body`] / [`decrypt_full_body`].
//!
//! **Code fences are respected.** `:::secret` patterns inside Markdown ``` / `~~~`
//! code fences are treated as examples and never encrypted, decrypted, or counted.
//!
//! **Block-level operations.** The later half of this file ([`patch_block`],
//! [`delete_block`], [`rename_block`], [`list_blocks`]) edits a single block's
//! fields within an already-decrypted page — used by the browser-extension PATCH
//! endpoints and mirrored by the mobile native module. These fail closed on input
//! that would break the line-based fence format so a value can never be written
//! unencrypted (see [`breaks_secret_fence`]).

use crate::crypto::vault_key;

use super::error::PageError;

/// Prefix for encrypted secret block content on disk.
const ENC_PREFIX: &str = "enc:v1:";

/// Encrypt all plaintext secret blocks in markdown content.
///
/// Transforms:
/// ```text
/// :::secret[Label]
/// field1: value1
/// field2: value2
/// :::
/// ```
/// Into:
/// ```text
/// :::secret[Label]
/// enc:v1:<base64>
/// :::
/// ```
///
/// Blocks already encrypted (starting with `enc:v1:`) are left as-is.
pub fn encrypt_secrets(content: &str, master_key: &[u8]) -> Result<String, PageError> {
    transform_secrets(content, |block_content| {
        // Skip already-encrypted blocks
        let trimmed = block_content.trim();
        if trimmed.starts_with(ENC_PREFIX) {
            return Ok(block_content.to_string());
        }

        let encoded = vault_key::encrypt_block(master_key, block_content)
            .map_err(|e| PageError::Crypto(e.to_string()))?;
        Ok(format!("{ENC_PREFIX}{encoded}"))
    })
}

/// Decrypt all encrypted secret blocks in markdown content.
///
/// Transforms `enc:v1:<base64>` back into plaintext within secret fences.
/// Blocks that are already plaintext (not starting with `enc:v1:`) are left as-is.
pub fn decrypt_secrets(content: &str, master_key: &[u8]) -> Result<String, PageError> {
    transform_secrets(content, |block_content| {
        let trimmed = block_content.trim();
        if !trimmed.starts_with(ENC_PREFIX) {
            return Ok(block_content.to_string());
        }

        let encoded = &trimmed[ENC_PREFIX.len()..];
        // Per-block fallback: if a single block can't be decrypted (e.g.
        // encrypted with a different vault's master key), leave the raw
        // `enc:v1:<base64>` on disk so the next save doesn't overwrite
        // the ciphertext. The block stays visible to the user as raw
        // ciphertext, making it obvious it's encrypted with the wrong
        // key — but the rest of the page renders normally.
        match vault_key::decrypt_block(master_key, encoded) {
            Ok(plaintext) => Ok(plaintext.to_string()),
            Err(e) => {
                log::warn!("[secret] block decrypt failed, preserving ciphertext: {e}");
                Ok(block_content.to_string())
            }
        }
    })
}

/// Decrypt secrets for export. Same as `decrypt_secrets` but replaces any
/// block that can't be decrypted with a visible plaintext placeholder
/// instead of preserving the `enc:v1:<base64>` ciphertext. Export files
/// must always be portable — ciphertext in an export would be unreadable
/// by any other tool (and by Claspt itself when re-imported into a
/// different vault).
pub fn decrypt_secrets_for_export(content: &str, master_key: &[u8]) -> Result<String, PageError> {
    transform_secrets(content, |block_content| {
        let trimmed = block_content.trim();
        if !trimmed.starts_with(ENC_PREFIX) {
            return Ok(block_content.to_string());
        }

        let encoded = &trimmed[ENC_PREFIX.len()..];
        match vault_key::decrypt_block(master_key, encoded) {
            Ok(plaintext) => Ok(plaintext.to_string()),
            Err(e) => {
                log::warn!("[secret] export decrypt failed, emitting placeholder: {e}");
                Ok(
                    "[secret could not be decrypted — encrypted with a different vault's key]\n"
                        .to_string(),
                )
            }
        }
    })
}

/// Same as `decrypt_full_body` but swallows decryption failures and returns
/// a visible plaintext placeholder so the exported file is always readable.
pub fn decrypt_full_body_for_export(content: &str, master_key: &[u8]) -> String {
    match decrypt_full_body(content, master_key) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("[secret] export full-body decrypt failed: {e}");
            "[page body could not be decrypted — encrypted with a different vault's key]\n"
                .to_string()
        }
    }
}

/// Encrypt the entire page body as a single blob.
///
/// Returns `"enc:v1:<base64>"` — the same format used by secret blocks
/// but applied to the full body content.
pub fn encrypt_full_body(content: &str, master_key: &[u8]) -> Result<String, PageError> {
    let encoded = vault_key::encrypt_block(master_key, content)
        .map_err(|e| PageError::Crypto(e.to_string()))?;
    Ok(format!("{ENC_PREFIX}{encoded}"))
}

/// Decrypt a full-body encrypted page.
///
/// Strips the `enc:v1:` prefix, decrypts the base64 blob, and returns
/// the original plaintext body.
pub fn decrypt_full_body(content: &str, master_key: &[u8]) -> Result<String, PageError> {
    let trimmed = content.trim();
    if !trimmed.starts_with(ENC_PREFIX) {
        return Err(PageError::Crypto(
            "content is not full-body encrypted".into(),
        ));
    }
    let encoded = &trimmed[ENC_PREFIX.len()..];
    let plaintext = vault_key::decrypt_block(master_key, encoded)
        .map_err(|e| PageError::Crypto(e.to_string()))?;
    Ok(plaintext.to_string())
}

/// Redact every secret block body, replacing it with `[REDACTED]`.
///
/// Labels and surrounding markdown are preserved — labels are plaintext on disk
/// regardless, and the browser extension lists them to choose a credential.
///
/// This is the only thing between a Notes-scope token and a secret it may not
/// read, so it is written to be incapable of failing or of skipping a block:
///
/// - It does NOT reuse `transform_secrets`, which deliberately ignores blocks
///   inside markdown code fences so documentation can show the syntax. A fenced
///   block is never encrypted, so its body is real cleartext — precisely the
///   case that most needs removing, and it was previously returned verbatim.
/// - It returns `String` rather than a `Result` that used to be unwrapped back
///   to the untouched page, which made the error path less safe than the
///   success path.
/// - It opens on the `:::secret[` prefix alone and closes on any line that
///   trims to `:::`, matching how the encryptor and the block reader behave, so
///   an unparseable label or an indented fence cannot leave a body exposed.
///
/// The cost is that a documentation example inside a code fence also comes back
/// redacted over the API. That is the right way round.
pub fn redact_secrets(content: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    let mut inside_block = false;

    for line in content.lines() {
        if inside_block {
            // Body lines are dropped rather than copied, so nothing from inside
            // a block can reach the output by any path.
            if line.trim() == ":::" {
                out.push("[REDACTED]");
                out.push(line);
                inside_block = false;
            }
            continue;
        }

        out.push(line);
        if line.trim().starts_with(":::secret[") {
            inside_block = true;
        }
    }

    // A block with no closing fence — a page truncated mid-write, or one whose
    // label does not parse. Its body was dropped above; record that something
    // was removed rather than truncating silently.
    if inside_block {
        out.push("[REDACTED]");
    }

    out.join("\n")
}

/// Check if content contains any `:::secret[...]` blocks (outside code fences).
pub fn has_secret_blocks(content: &str) -> bool {
    let mut in_code_fence = false;
    for line in content.lines() {
        if is_code_fence(line) {
            in_code_fence = !in_code_fence;
            continue;
        }
        if !in_code_fence && parse_secret_open(line).is_some() {
            return true;
        }
    }
    false
}

/// Extract secret block labels from markdown content (for search indexing).
///
/// Labels are always plaintext regardless of encryption state.
/// Skips `:::secret[...]` patterns inside fenced code blocks.
pub fn extract_secret_labels(content: &str) -> Vec<String> {
    let mut labels = Vec::new();
    let mut in_code_fence = false;
    for line in content.lines() {
        if is_code_fence(line) {
            in_code_fence = !in_code_fence;
            continue;
        }
        if !in_code_fence {
            if let Some(label) = parse_secret_open(line) {
                labels.push(label);
            }
        }
    }
    labels
}

/// A secret block's label and whether its body is sealed on disk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretBlockState {
    pub label: String,
    /// True only when the body is the `enc:v1:` sentinel. A plaintext body, an
    /// empty body, and a block with no closing fence all report false, because
    /// none of them is protected.
    pub encrypted: bool,
    /// True when nothing sits between the fences, so there is nothing to leak.
    pub empty: bool,
    /// False when the block has no closing fence. Such a block swallows the
    /// rest of the page: nothing appended after it would be encrypted.
    pub closed: bool,
}

/// Label and encryption state of every secret block, in document order.
///
/// This is what lets an index or an audit tell a sealed block from one whose
/// value is sitting in the file as written. [`extract_secret_labels`] cannot:
/// a plaintext block and an encrypted one have identical labels, which is how
/// a live key went unnoticed in a scratch page on 2026-08-26. Blocks inside
/// code fences are examples and are not listed, matching the encryptor.
pub fn secret_block_states(content: &str) -> Vec<SecretBlockState> {
    let mut states = Vec::new();
    let mut in_code_fence = false;
    let mut lines = content.lines();
    while let Some(line) = lines.next() {
        if is_code_fence(line) {
            in_code_fence = !in_code_fence;
            continue;
        }
        if in_code_fence {
            continue;
        }
        let Some(label) = parse_secret_open(line) else {
            continue;
        };
        let mut body = String::new();
        let mut closed = false;
        for inner in lines.by_ref() {
            if inner.trim() == ":::" {
                closed = true;
                break;
            }
            if !body.is_empty() {
                body.push('\n');
            }
            body.push_str(inner);
        }
        let trimmed = body.trim();
        states.push(SecretBlockState {
            label,
            encrypted: closed && trimmed.starts_with(ENC_PREFIX),
            empty: trimmed.is_empty(),
            closed,
        });
    }
    states
}

/// Check if a line opens a secret block, returning the label if so.
///
/// Handles escaped brackets: `:::secret[mongodb.com[2\]]` → label `mongodb.com[2]`.
/// The `\]` escape sequence is unescaped in the returned label.
pub(super) fn parse_secret_open(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if !trimmed.starts_with(":::secret[") {
        return None;
    }
    let after_bracket = &trimmed[":::secret[".len()..];

    // A `]` closes the label only when preceded by an EVEN number of
    // backslashes; an odd count means the last one escapes it. Counting the run
    // (rather than testing the single preceding byte) is what lets a label end
    // in a backslash: `escape_label` writes that as `\\`, and an even run
    // correctly leaves the following `]` as the terminator. Reading only one
    // byte back treated it as escaped, found no terminator, and dropped the
    // whole block — which meant its values were written to disk unencrypted.
    let bytes = after_bracket.as_bytes();
    let mut end = None;
    for i in 0..bytes.len() {
        if bytes[i] != b']' {
            continue;
        }
        let backslashes = bytes[..i].iter().rev().take_while(|&&b| b == b'\\').count();
        if backslashes % 2 == 0 {
            end = Some(i);
            break;
        }
    }

    let end = end?;
    Some(unescape_label(&after_bracket[..end]))
}

/// Reverse [`escape_label`].
///
/// Only `\\` and `\]` are treated as escape sequences; a backslash before any
/// other character is kept literally. That is deliberate: builds before 3.0.11
/// escaped `]` but never escaped `\`, so labels like `C:\Users\me` were written
/// raw. Leaving unknown sequences alone is what lets those files keep reading
/// back unchanged, with no migration.
fn unescape_label(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' && matches!(chars.peek(), Some('\\') | Some(']')) {
            out.push(chars.next().expect("peeked"));
            continue;
        }
        out.push(c);
    }
    out
}

/// Check if a line opens or closes a markdown fenced code block (``` or ~~~).
pub(super) fn is_code_fence(line: &str) -> bool {
    let trimmed = line.trim();
    trimmed.starts_with("```") || trimmed.starts_with("~~~")
}

/// Generic transformer that processes each secret block's content through a callback.
///
/// Skips `:::secret[...]` patterns that appear inside fenced code blocks (``` or ~~~),
/// since those are markdown examples rather than real secret blocks.
fn transform_secrets<F>(content: &str, transform: F) -> Result<String, PageError>
where
    F: Fn(&str) -> Result<String, PageError>,
{
    let mut result = String::with_capacity(content.len());
    let mut lines = content.lines().peekable();
    let mut first_line = true;
    let mut in_code_fence = false;

    while let Some(line) = lines.next() {
        if !first_line {
            result.push('\n');
        }
        first_line = false;

        // Track fenced code blocks — don't process secrets inside them
        if is_code_fence(line) {
            in_code_fence = !in_code_fence;
            result.push_str(line);
            continue;
        }

        if !in_code_fence && parse_secret_open(line).is_some() {
            // Write the opening fence as-is
            result.push_str(line);
            result.push('\n');

            // Collect block content until closing :::
            let mut block_content = String::new();
            let mut found_close = false;

            for inner_line in lines.by_ref() {
                let inner_trimmed = inner_line.trim();
                if inner_trimmed == ":::" {
                    // Transform the collected content
                    let transformed = transform(&block_content)?;
                    result.push_str(&transformed);
                    result.push('\n');
                    result.push_str(":::");
                    found_close = true;
                    break;
                }
                if !block_content.is_empty() {
                    block_content.push('\n');
                }
                block_content.push_str(inner_line);
            }

            if !found_close {
                // Unclosed secret block — append collected content as-is
                result.push_str(&block_content);
            }
        } else {
            result.push_str(line);
        }
    }

    Ok(result)
}

// ── Block-level granular operations (v2.0.0) ─────────────────────
//
// These operate on a single :::secret[Label]:::  block within a page,
// preserving all other blocks and surrounding markdown. Used by the
// PATCH /api/pages/{*}/secret endpoints (browser extension CRUD) and
// mirrored by the mobile native module's secretNative.* functions.
//
// All operations are content-only — they take and return decrypted
// markdown. Encryption happens in the calling layer (route handler /
// mobile native module) via encrypt_secrets() before writing to disk.

/// Find the position (line range) of the secret block whose label exactly
/// matches `label`, ignoring blocks inside fenced code blocks.
///
/// Returns `(open_line_index, close_line_index)` where both are inclusive
/// indices into `content.lines()`. Returns None if no block matches.
fn find_block_range(content: &str, label: &str) -> Option<(usize, usize)> {
    let mut in_code_fence = false;
    let mut open_idx: Option<usize> = None;
    for (i, line) in content.lines().enumerate() {
        if is_code_fence(line) {
            in_code_fence = !in_code_fence;
            continue;
        }
        if in_code_fence {
            continue;
        }
        if let Some(open_label) = parse_secret_open(line) {
            if open_label == label {
                open_idx = Some(i);
                continue;
            }
        }
        if let Some(idx) = open_idx {
            if line.trim() == ":::" {
                return Some((idx, i));
            }
        }
    }
    None
}

/// Parse the body lines of a secret block into ordered (key, value) pairs.
///
/// Lines that don't match `key: value` are preserved as-is via the
/// `Other` variant — used for comment lines, blank lines, or content
/// that doesn't fit the field pattern. Order is preserved so unknown
/// fields don't get reshuffled.
#[derive(Debug, Clone)]
enum BlockLine {
    Field(String, String),
    Other(String),
}

fn parse_block_lines(body: &str) -> Vec<BlockLine> {
    body.lines()
        .map(|line| {
            // Skip lines that look like the encrypted-content sentinel.
            if line.starts_with(ENC_PREFIX) {
                return BlockLine::Other(line.to_string());
            }
            if let Some(idx) = line.find(':') {
                let key = line[..idx].trim();
                if !key.is_empty() && is_valid_field_key(key) {
                    let value = line[idx + 1..].trim_start().to_string();
                    return BlockLine::Field(key.to_string(), value);
                }
            }
            BlockLine::Other(line.to_string())
        })
        .collect()
}

/// Field keys are restricted to a conservative ASCII set — alphanumeric,
/// underscore, hyphen, dot, space — to keep round-trip parsing stable.
fn is_valid_field_key(key: &str) -> bool {
    !key.is_empty()
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.' || c == ' ')
}

fn serialize_block_lines(lines: &[BlockLine]) -> String {
    lines
        .iter()
        .map(|l| match l {
            BlockLine::Field(k, v) => format!("{k}: {v}"),
            BlockLine::Other(s) => s.clone(),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Result of applying a block-level operation.
#[derive(Debug, Clone)]
pub struct BlockOpResult {
    /// The new (decrypted) page content after the operation.
    pub content: String,
    /// True if the page now has zero secret blocks AND no non-trivial
    /// markdown body. Callers may choose to delete the page entirely.
    pub page_empty: bool,
}

/// Non-destructive merge of fields into the named secret block.
///
/// - `fields` — keys to set or update. Empty-string values delete the field.
/// - `delete_fields` — keys to remove (alternative to setting empty).
/// - `upsert` — if true and no block matches, append a new block.
///
/// `content` is decrypted markdown (caller decrypted before passing).
/// Returns decrypted markdown (caller encrypts after).
pub fn patch_block(
    content: &str,
    label: &str,
    fields: &[(String, String)],
    delete_fields: &[String],
    upsert: bool,
) -> Result<BlockOpResult, PatchError> {
    // Fail closed on fence-breaking input so a value can never be stored
    // unencrypted (a newline in the label splits the open fence; a newline in a
    // field key OR value can inject a premature `:::` close, pushing later
    // content outside the encrypted block). Covers every write path through
    // patch_block, including the browser-extension PATCH /secret endpoint.
    if breaks_secret_fence(label) {
        return Err(PatchError::InvalidInput);
    }
    for (k, v) in fields {
        if breaks_secret_fence(k) || breaks_secret_fence(v) {
            return Err(PatchError::InvalidInput);
        }
    }

    let range = find_block_range(content, label);
    let new_content = match range {
        Some((open_idx, close_idx)) => {
            let lines: Vec<&str> = content.lines().collect();
            let body = lines[open_idx + 1..close_idx].join("\n");
            let mut block_lines = parse_block_lines(&body);

            // Apply field updates.
            for (k, v) in fields {
                let pos = block_lines
                    .iter()
                    .position(|l| matches!(l, BlockLine::Field(key, _) if key == k));
                if v.is_empty() {
                    if let Some(p) = pos {
                        block_lines.remove(p);
                    }
                } else if let Some(p) = pos {
                    block_lines[p] = BlockLine::Field(k.clone(), v.clone());
                } else {
                    block_lines.push(BlockLine::Field(k.clone(), v.clone()));
                }
            }
            // Apply explicit deletions.
            for k in delete_fields {
                block_lines.retain(|l| !matches!(l, BlockLine::Field(key, _) if key == k));
            }

            let new_body = serialize_block_lines(&block_lines);
            // Rebuild the page line-by-line preserving all non-block content.
            let mut out = Vec::with_capacity(lines.len());
            for (i, line) in lines.iter().enumerate() {
                if i == open_idx {
                    out.push(line.to_string());
                    if !new_body.is_empty() {
                        out.push(new_body.clone());
                    }
                } else if i > open_idx && i < close_idx {
                    // skip — replaced above
                } else {
                    out.push(line.to_string());
                }
            }
            // Preserve trailing newline if the original had one.
            let mut joined = out.join("\n");
            if content.ends_with('\n') && !joined.ends_with('\n') {
                joined.push('\n');
            }
            joined
        }
        None => {
            if !upsert {
                return Err(PatchError::BlockNotFound);
            }
            // Append new block at the end.
            let mut block = format!(":::secret[{}]\n", escape_label(label));
            for (k, v) in fields {
                if v.is_empty() {
                    continue;
                }
                block.push_str(&format!("{k}: {v}\n"));
            }
            block.push_str(":::");
            let sep = if content.is_empty() || content.ends_with("\n\n") {
                ""
            } else if content.ends_with('\n') {
                "\n"
            } else {
                "\n\n"
            };
            let mut out = format!("{content}{sep}{block}");
            if content.ends_with('\n') {
                out.push('\n');
            }
            out
        }
    };

    Ok(BlockOpResult {
        page_empty: is_page_effectively_empty(&new_content),
        content: new_content,
    })
}

/// Remove a single secret block from the page entirely.
///
/// Returns `BlockOpResult` with `page_empty: true` if the page is now
/// effectively empty (only frontmatter / blank lines / heading).
pub fn delete_block(content: &str, label: &str) -> Result<BlockOpResult, PatchError> {
    let (open_idx, close_idx) =
        find_block_range(content, label).ok_or(PatchError::BlockNotFound)?;
    let lines: Vec<&str> = content.lines().collect();
    let mut out: Vec<&str> = Vec::with_capacity(lines.len());
    for (i, line) in lines.iter().enumerate() {
        if i >= open_idx && i <= close_idx {
            continue;
        }
        out.push(line);
    }
    // Collapse consecutive blank lines left by the deletion.
    let mut collapsed: Vec<&str> = Vec::with_capacity(out.len());
    let mut prev_blank = false;
    for line in out {
        let blank = line.trim().is_empty();
        if blank && prev_blank {
            continue;
        }
        collapsed.push(line);
        prev_blank = blank;
    }
    let mut joined = collapsed.join("\n");
    if content.ends_with('\n') && !joined.ends_with('\n') {
        joined.push('\n');
    }
    Ok(BlockOpResult {
        page_empty: is_page_effectively_empty(&joined),
        content: joined,
    })
}

/// Rename a secret block's label without touching its fields.
///
/// Errors with `LabelConflict` if a different block on the same page
/// already uses `new_label`.
pub fn rename_block(content: &str, old_label: &str, new_label: &str) -> Result<String, PatchError> {
    if old_label == new_label {
        return Ok(content.to_string());
    }
    if find_block_range(content, new_label).is_some() {
        return Err(PatchError::LabelConflict);
    }
    let (open_idx, _close_idx) =
        find_block_range(content, old_label).ok_or(PatchError::BlockNotFound)?;
    let lines: Vec<&str> = content.lines().collect();
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    for (i, line) in lines.iter().enumerate() {
        if i == open_idx {
            // Rebuild the open fence with the new label, preserving any leading whitespace.
            let leading: String = line.chars().take_while(|c| c.is_whitespace()).collect();
            out.push(format!("{}:::secret[{}]", leading, escape_label(new_label)));
        } else {
            out.push(line.to_string());
        }
    }
    let mut joined = out.join("\n");
    if content.ends_with('\n') && !joined.ends_with('\n') {
        joined.push('\n');
    }
    Ok(joined)
}

/// List all secret blocks in a page as (label, fields) pairs.
///
/// Caller must pass DECRYPTED content. Order matches block order in the page.
pub fn list_blocks(content: &str) -> Vec<(String, Vec<(String, String)>)> {
    let mut blocks = Vec::new();
    let labels = extract_secret_labels(content);
    for label in labels {
        if let Some((open_idx, close_idx)) = find_block_range(content, &label) {
            let lines: Vec<&str> = content.lines().collect();
            let body = lines[open_idx + 1..close_idx].join("\n");
            let parsed = parse_block_lines(&body);
            let fields: Vec<(String, String)> = parsed
                .into_iter()
                .filter_map(|l| match l {
                    BlockLine::Field(k, v) => Some((k, v)),
                    BlockLine::Other(_) => None,
                })
                .collect();
            blocks.push((label, fields));
        }
    }
    blocks
}

/// Heuristic: page is effectively empty if it contains no secret blocks
/// and only blank lines / frontmatter-stripped text. Used by callers to
/// decide whether to delete the page entirely after a block delete.
fn is_page_effectively_empty(content: &str) -> bool {
    if has_secret_blocks(content) {
        return false;
    }
    for line in content.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with("#") {
            continue;
        }
        return false;
    }
    true
}

/// Escape a label so the open fence parses round-trip, for any label the block
/// API accepts.
///
/// Order matters: the escape character is escaped first, otherwise the
/// backslashes introduced when escaping `]` would themselves be escaped on a
/// second pass and the label would not survive [`unescape_label`].
pub(crate) fn escape_label(label: &str) -> String {
    label.replace('\\', "\\\\").replace(']', "\\]")
}

/// Errors returned by the block-level operations.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PatchError {
    BlockNotFound,
    LabelConflict,
    /// A label or field value contained a character that would break the
    /// line-based secret-block format (newline, carriage return, or other
    /// control char), which could cause the block to be stored UNENCRYPTED.
    InvalidInput,
}

impl std::fmt::Display for PatchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BlockNotFound => write!(f, "Secret block not found"),
            Self::LabelConflict => write!(f, "A different block already uses the new label"),
            Self::InvalidInput => write!(
                f,
                "Secret label and field values may not contain newlines or control characters"
            ),
        }
    }
}

/// Reject input that would break the line-based `:::secret[...]:::` block
/// format. A newline (or other control char) in the label or a field value can
/// split the open fence or inject a bare `:::` line, which makes the block
/// unrecognizable to the encryptor — so the value would be written to disk in
/// PLAINTEXT. Field keys are already constrained by `is_valid_field_key`.
fn breaks_secret_fence(s: &str) -> bool {
    s.chars()
        .any(|c| c == '\n' || c == '\r' || c == '\0' || (c.is_control() && c != '\t'))
}

impl std::error::Error for PatchError {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::aead;

    /// Cross-crate sync guard: the secret-block parsing/encryption in this
    /// module is (historically) duplicated in `claspt_core::pages::secret` — the
    /// two crates carry distinct `PageError` types, which is why the logic was
    /// copied rather than shared. This test fails if the two implementations ever
    /// diverge on format or detection, so a fix to one is not silently missed in
    /// the other.
    #[test]
    fn stays_in_sync_with_claspt_core_secret() {
        let key = test_master_key();
        // No trailing newline: the encrypt→decrypt transform normalizes a
        // trailing newline away (identically in both crates), which is unrelated
        // to the format compatibility this guard checks.
        let sample = "# Note\n\n:::secret[github.com]\nuser: me\npass: hunter2\n:::\n\ntext\n\n```\n:::secret[in code fence]\n```";

        // Detection + label extraction must agree between the two crates.
        assert_eq!(
            has_secret_blocks(sample),
            claspt_core::pages::secret::has_secret_blocks(sample),
            "has_secret_blocks diverged from claspt-core"
        );
        assert_eq!(
            extract_secret_labels(sample),
            claspt_core::pages::secret::extract_secret_labels(sample),
            "extract_secret_labels diverged from claspt-core"
        );

        // Format compatibility: a block encrypted by THIS crate must decrypt with
        // claspt-core's decryptor, and vice-versa, back to the same plaintext.
        let enc_here = encrypt_secrets(sample, &key).unwrap();
        let dec_core = claspt_core::pages::secret::decrypt_secrets(&enc_here, &key).unwrap();
        assert_eq!(
            dec_core, sample,
            "core could not decrypt this crate's output"
        );

        let enc_core = claspt_core::pages::secret::encrypt_secrets(sample, &key).unwrap();
        let dec_here = decrypt_secrets(&enc_core, &key).unwrap();
        assert_eq!(
            dec_here, sample,
            "this crate could not decrypt core's output"
        );
    }

    fn test_master_key() -> Vec<u8> {
        aead::generate_master_key().unwrap().to_vec()
    }

    #[test]
    fn encrypt_decrypt_roundtrip() {
        let key = test_master_key();
        let content = "\
# My Note

Some text here.

:::secret[API Key]
key: sk-12345
env: production
:::

More text after.";

        let encrypted = encrypt_secrets(content, &key).unwrap();

        // Labels should remain plaintext
        assert!(encrypted.contains(":::secret[API Key]"));
        assert!(encrypted.contains(":::"));
        // Content should be encrypted
        assert!(!encrypted.contains("sk-12345"));
        assert!(!encrypted.contains("env: production"));
        assert!(encrypted.contains(ENC_PREFIX));
        // Non-secret content should be preserved
        assert!(encrypted.contains("# My Note"));
        assert!(encrypted.contains("Some text here."));
        assert!(encrypted.contains("More text after."));

        let decrypted = decrypt_secrets(&encrypted, &key).unwrap();
        assert_eq!(decrypted, content);
    }

    #[test]
    fn multiple_secret_blocks() {
        let key = test_master_key();
        let content = "\
:::secret[Password]
mypassword123
:::

Some middle text.

:::secret[Credit Card]
number: 4111-1111-1111-1111
cvv: 123
:::";

        let encrypted = encrypt_secrets(content, &key).unwrap();
        assert!(encrypted.contains(":::secret[Password]"));
        assert!(encrypted.contains(":::secret[Credit Card]"));
        assert!(!encrypted.contains("mypassword123"));
        assert!(!encrypted.contains("4111-1111-1111-1111"));

        let decrypted = decrypt_secrets(&encrypted, &key).unwrap();
        assert_eq!(decrypted, content);
    }

    #[test]
    fn no_secret_blocks_unchanged() {
        let key = test_master_key();
        let content = "# Just a regular note\n\nNo secrets here.";

        let encrypted = encrypt_secrets(content, &key).unwrap();
        assert_eq!(encrypted, content);

        let decrypted = decrypt_secrets(&encrypted, &key).unwrap();
        assert_eq!(decrypted, content);
    }

    #[test]
    fn already_encrypted_blocks_not_double_encrypted() {
        let key = test_master_key();
        let content = ":::secret[Test]\nplaintext value\n:::";

        let encrypted = encrypt_secrets(content, &key).unwrap();
        // Encrypt again — should not change
        let double_encrypted = encrypt_secrets(&encrypted, &key).unwrap();
        assert_eq!(encrypted, double_encrypted);
    }

    #[test]
    fn extract_labels() {
        let content = "\
# Note

:::secret[API Key]
enc:v1:somebase64
:::

Text.

:::secret[Database Password]
enc:v1:otherbase64
:::";

        let labels = extract_secret_labels(content);
        assert_eq!(labels, vec!["API Key", "Database Password"]);
    }

    #[test]
    fn extract_labels_no_secrets() {
        let content = "# Regular note\n\nNo secrets.";
        let labels = extract_secret_labels(content);
        assert!(labels.is_empty());
    }

    #[test]
    fn extract_labels_skips_code_fences() {
        let content = "\
:::secret[Real]
value
:::

```
:::secret[Fake Example]
enc:v1:NOT_REAL
:::
```

:::secret[Also Real]
value2
:::";

        let labels = extract_secret_labels(content);
        assert_eq!(labels, vec!["Real", "Also Real"]);
    }

    #[test]
    fn empty_secret_block() {
        let key = test_master_key();
        let content = ":::secret[Empty]\n\n:::";

        let encrypted = encrypt_secrets(content, &key).unwrap();
        assert!(encrypted.contains(":::secret[Empty]"));

        let decrypted = decrypt_secrets(&encrypted, &key).unwrap();
        assert_eq!(decrypted, content);
    }

    #[test]
    fn wrong_key_preserves_ciphertext_on_decrypt() {
        // `decrypt_secrets` intentionally falls back to preserving the
        // `enc:v1:<base64>` ciphertext when a block can't be decrypted so
        // the rest of the page still renders and subsequent saves don't
        // overwrite the original ciphertext.
        let key1 = test_master_key();
        let key2 = test_master_key();
        let content = ":::secret[Test]\nsecret value\n:::";

        let encrypted = encrypt_secrets(content, &key1).unwrap();
        let decrypted_with_wrong_key = decrypt_secrets(&encrypted, &key2).unwrap();
        assert!(decrypted_with_wrong_key.contains(ENC_PREFIX));
        assert!(!decrypted_with_wrong_key.contains("secret value"));
    }

    #[test]
    fn wrong_key_export_emits_placeholder() {
        // Exports must never leak ciphertext. `decrypt_secrets_for_export`
        // replaces undecryptable blocks with a visible plaintext placeholder.
        let key1 = test_master_key();
        let key2 = test_master_key();
        let content = ":::secret[Test]\nsecret value\n:::";

        let encrypted = encrypt_secrets(content, &key1).unwrap();
        let exported = decrypt_secrets_for_export(&encrypted, &key2).unwrap();
        assert!(!exported.contains(ENC_PREFIX));
        assert!(exported.contains("could not be decrypted"));
    }

    #[test]
    fn export_then_import_into_different_vault_reencrypts() {
        // Full cross-vault round-trip: a secret encrypted by vault A is
        // exported to plaintext, then imported by vault B which re-encrypts
        // it with B's master key. B can read its own ciphertext; the original
        // plaintext never leaks out of the export payload.
        let vault_a_key = test_master_key();
        let vault_b_key = test_master_key();
        let plaintext = "\
# Banking
:::secret[Deutsch Bank UK]
username: alice
password: correct horse battery staple
:::";

        // Vault A encrypts on save
        let vault_a_encrypted = encrypt_secrets(plaintext, &vault_a_key).unwrap();
        assert!(vault_a_encrypted.contains(ENC_PREFIX));
        assert!(!vault_a_encrypted.contains("correct horse battery staple"));

        // Export — decrypts with vault A's key, emits plaintext, keeps the fence
        let exported = decrypt_secrets_for_export(&vault_a_encrypted, &vault_a_key).unwrap();
        assert!(!exported.contains(ENC_PREFIX));
        assert!(exported.contains(":::secret[Deutsch Bank UK]"));
        assert!(exported.contains("password: correct horse battery staple"));

        // Import into vault B — `encrypt_secrets` finds the fence and
        // encrypts the inner value with B's key, regardless of vault A's key.
        let vault_b_encrypted = encrypt_secrets(&exported, &vault_b_key).unwrap();
        assert!(vault_b_encrypted.contains(":::secret[Deutsch Bank UK]"));
        assert!(vault_b_encrypted.contains(ENC_PREFIX));
        assert!(!vault_b_encrypted.contains("correct horse battery staple"));

        // Vault B can read its own ciphertext back to the original plaintext
        let decrypted_in_b = decrypt_secrets(&vault_b_encrypted, &vault_b_key).unwrap();
        assert!(decrypted_in_b.contains("password: correct horse battery staple"));

        // Vault A's key must NOT decrypt vault B's ciphertext (keys are
        // independent, as expected)
        let attempted = decrypt_secrets(&vault_b_encrypted, &vault_a_key).unwrap();
        assert!(attempted.contains(ENC_PREFIX));
        assert!(!attempted.contains("correct horse battery staple"));
    }

    #[test]
    fn full_body_encrypt_decrypt_roundtrip() {
        let key = test_master_key();
        let content = "# My Secret Page\n\nSensitive stuff here.\n\n:::secret[Key]\nvalue\n:::";

        let encrypted = encrypt_full_body(content, &key).unwrap();
        assert!(encrypted.starts_with(ENC_PREFIX));
        assert!(!encrypted.contains("Sensitive stuff"));
        assert!(!encrypted.contains(":::secret"));

        let decrypted = decrypt_full_body(&encrypted, &key).unwrap();
        assert_eq!(decrypted, content);
    }

    #[test]
    fn full_body_wrong_key_fails() {
        let key1 = test_master_key();
        let key2 = test_master_key();
        let content = "Secret body content";

        let encrypted = encrypt_full_body(content, &key1).unwrap();
        let result = decrypt_full_body(&encrypted, &key2);
        assert!(result.is_err());
    }

    #[test]
    fn full_body_empty_content() {
        let key = test_master_key();
        let content = "";

        let encrypted = encrypt_full_body(content, &key).unwrap();
        let decrypted = decrypt_full_body(&encrypted, &key).unwrap();
        assert_eq!(decrypted, content);
    }

    #[test]
    fn preserves_content_around_secrets() {
        let key = test_master_key();
        let content = "\
Line 1
Line 2

:::secret[Creds]
user: admin
pass: secret
:::

Line 3
Line 4";

        let encrypted = encrypt_secrets(content, &key).unwrap();
        let decrypted = decrypt_secrets(&encrypted, &key).unwrap();
        assert_eq!(decrypted, content);
    }

    #[test]
    fn redact_secrets_replaces_content() {
        let content = "\
# My Note

:::secret[API Key]
sk-12345
:::

More text.";

        let redacted = redact_secrets(content);
        assert!(redacted.contains(":::secret[API Key]"));
        assert!(redacted.contains("[REDACTED]"));
        assert!(!redacted.contains("sk-12345"));
        assert!(redacted.contains("# My Note"));
        assert!(redacted.contains("More text."));
    }

    #[test]
    fn redact_secrets_no_secrets_unchanged() {
        let content = "# Regular note\n\nNo secrets here.";
        let redacted = redact_secrets(content);
        assert_eq!(redacted, content);
    }

    #[test]
    fn has_secret_blocks_detects() {
        assert!(has_secret_blocks(":::secret[Key]\nvalue\n:::"));
        assert!(!has_secret_blocks("# No secrets"));
        // Inside code fence should not count
        assert!(!has_secret_blocks("```\n:::secret[Fake]\nval\n:::\n```"));
    }

    #[test]
    fn secret_inside_code_fence_ignored() {
        let key = test_master_key();
        let content = "\
# Example

```
:::secret[Demo]
enc:v1:NOT_REAL_BASE64...
:::
```

Real content here.";

        // Should NOT try to decrypt the fake enc:v1: inside the code fence
        let decrypted = decrypt_secrets(content, &key).unwrap();
        assert_eq!(decrypted, content);

        // Encryption should also leave code-fenced secrets alone
        let encrypted = encrypt_secrets(content, &key).unwrap();
        assert_eq!(encrypted, content);
    }

    #[test]
    fn real_secret_after_code_fence_still_works() {
        let key = test_master_key();
        let content = "\
```
:::secret[Fake]
not-encrypted
:::
```

:::secret[Real]
actual-secret-value
:::";

        let encrypted = encrypt_secrets(content, &key).unwrap();
        // The fake one inside code fence should be untouched
        assert!(encrypted.contains("not-encrypted"));
        // The real one outside code fence should be encrypted
        assert!(!encrypted.contains("actual-secret-value"));
        assert!(encrypted.contains(ENC_PREFIX));

        let decrypted = decrypt_secrets(&encrypted, &key).unwrap();
        assert_eq!(decrypted, content);
    }

    #[test]
    fn stress_encrypt_decrypt_large_content_with_secrets() {
        let key = test_master_key();
        // ~2 MB content with 200 secret blocks (no trailing newline, like CodeMirror output)
        let mut content = String::with_capacity(2_500_000);
        for i in 0..200 {
            if i > 0 {
                content.push_str("\n\n");
            }
            content.push_str(&format!("## Section {i}\n\n"));
            content.push_str(&"Lorem ipsum dolor sit amet. ".repeat(200));
            content.push_str(&format!(
                "\n\n:::secret[Key-{i}]\nsk-test-{}-{}\n:::",
                i,
                "x".repeat(500)
            ));
        }

        let encrypted = encrypt_secrets(&content, &key).unwrap();
        assert!(!encrypted.contains("sk-test-0-"));
        assert!(encrypted.contains(ENC_PREFIX));

        let decrypted = decrypt_secrets(&encrypted, &key).unwrap();
        assert_eq!(decrypted, content);
    }

    #[test]
    fn label_with_escaped_brackets() {
        let label = parse_secret_open(":::secret[mongodb.com[2\\]]").unwrap();
        assert_eq!(label, "mongodb.com[2]");
    }

    #[test]
    fn label_with_simple_brackets() {
        let label = parse_secret_open(":::secret[Simple Label]").unwrap();
        assert_eq!(label, "Simple Label");
    }

    #[test]
    fn extract_labels_with_escaped_brackets() {
        let content = ":::secret[site.com[1\\]]\nenc:v1:xxx\n:::";
        let labels = extract_secret_labels(content);
        assert_eq!(labels, vec!["site.com[1]"]);
    }

    #[test]
    fn stress_full_body_encrypt_5mb() {
        let key = test_master_key();
        let content = "Sensitive data block. ".repeat(250_000); // ~5.5 MB
        let encrypted = encrypt_full_body(&content, &key).unwrap();
        assert!(encrypted.starts_with(ENC_PREFIX));
        let decrypted = decrypt_full_body(&encrypted, &key).unwrap();
        assert_eq!(decrypted, content);
    }

    // ── Block-level operation tests ──────────────────────

    const SAMPLE_PAGE: &str = "# Page\n\n:::secret[github.com - foo]\nusername: foo\npassword: bar\nnote: original\n:::\n\n:::secret[github.com - bar]\nusername: barry\npassword: hunter2\n:::\n";

    #[test]
    fn patch_block_rejects_fence_injection_via_label_key_or_value() {
        // A newline + bare `:::` in the label, a field KEY, or a field VALUE must
        // be rejected — otherwise the injected close pushes later content outside
        // the fence, where encrypt_secrets would write it in plaintext.
        let inject = "a\n:::\ntail";
        assert!(patch_block("", inject, &[("k".into(), "v".into())], &[], true).is_err());
        assert!(patch_block("", "ok", &[(inject.into(), "SECRET".into())], &[], true).is_err());
        assert!(patch_block("", "ok", &[("k".into(), inject.into())], &[], true).is_err());
        // A clean block still works.
        assert!(patch_block("", "ok", &[("k".into(), "v".into())], &[], true).is_ok());
    }

    #[test]
    fn patch_block_merges_fields() {
        let fields = vec![
            ("password".to_string(), "newpass".to_string()),
            ("note".to_string(), "rotated 2026-04-26".to_string()),
        ];
        let res = patch_block(SAMPLE_PAGE, "github.com - foo", &fields, &[], false).unwrap();
        // username preserved, password updated, note replaced
        assert!(res.content.contains("username: foo"));
        assert!(res.content.contains("password: newpass"));
        assert!(res.content.contains("note: rotated 2026-04-26"));
        assert!(!res.content.contains("password: bar"));
        // other block untouched
        assert!(res.content.contains("username: barry"));
        assert!(!res.page_empty);
    }

    #[test]
    fn patch_block_empty_value_deletes_field() {
        let fields = vec![("note".to_string(), String::new())];
        let res = patch_block(SAMPLE_PAGE, "github.com - foo", &fields, &[], false).unwrap();
        assert!(!res.content.contains("note:"));
        assert!(res.content.contains("password: bar"));
    }

    #[test]
    fn patch_block_explicit_delete() {
        let res = patch_block(
            SAMPLE_PAGE,
            "github.com - foo",
            &[],
            &["note".to_string()],
            false,
        )
        .unwrap();
        assert!(!res.content.contains("note:"));
    }

    #[test]
    fn patch_block_not_found_without_upsert() {
        let err = patch_block(SAMPLE_PAGE, "missing", &[], &[], false).unwrap_err();
        assert_eq!(err, PatchError::BlockNotFound);
    }

    #[test]
    fn patch_block_upsert_appends_new_block() {
        let fields = vec![
            ("username".to_string(), "newuser".to_string()),
            ("password".to_string(), "newpw".to_string()),
        ];
        let res = patch_block(SAMPLE_PAGE, "newsite.com", &fields, &[], true).unwrap();
        assert!(res.content.contains(":::secret[newsite.com]"));
        assert!(res.content.contains("username: newuser"));
        // existing blocks preserved
        assert!(res.content.contains(":::secret[github.com - foo]"));
        assert!(res.content.contains(":::secret[github.com - bar]"));
    }

    #[test]
    fn delete_block_removes_one_block_keeps_others() {
        let res = delete_block(SAMPLE_PAGE, "github.com - foo").unwrap();
        assert!(!res.content.contains(":::secret[github.com - foo]"));
        assert!(!res.content.contains("username: foo"));
        // other block + heading preserved
        assert!(res.content.contains(":::secret[github.com - bar]"));
        assert!(res.content.contains("# Page"));
        assert!(!res.page_empty);
    }

    #[test]
    fn delete_block_marks_page_empty_when_only_block() {
        let single = "# Page\n\n:::secret[only]\nfoo: bar\n:::\n";
        let res = delete_block(single, "only").unwrap();
        // Should report empty (heading-only is considered empty for delete-page semantics)
        assert!(res.page_empty);
    }

    #[test]
    fn delete_block_not_found() {
        let err = delete_block(SAMPLE_PAGE, "missing").unwrap_err();
        assert_eq!(err, PatchError::BlockNotFound);
    }

    #[test]
    fn rename_block_changes_label_only() {
        let res = rename_block(SAMPLE_PAGE, "github.com - foo", "github.com - work").unwrap();
        assert!(res.contains(":::secret[github.com - work]"));
        assert!(!res.contains(":::secret[github.com - foo]"));
        // fields unchanged
        assert!(res.contains("username: foo"));
        assert!(res.contains("password: bar"));
    }

    #[test]
    fn rename_block_conflict() {
        let err = rename_block(SAMPLE_PAGE, "github.com - foo", "github.com - bar").unwrap_err();
        assert_eq!(err, PatchError::LabelConflict);
    }

    #[test]
    fn rename_block_not_found() {
        let err = rename_block(SAMPLE_PAGE, "missing", "anything").unwrap_err();
        assert_eq!(err, PatchError::BlockNotFound);
    }

    #[test]
    fn rename_block_no_op_when_same() {
        let res = rename_block(SAMPLE_PAGE, "github.com - foo", "github.com - foo").unwrap();
        assert_eq!(res, SAMPLE_PAGE);
    }

    #[test]
    fn list_blocks_returns_all_in_order() {
        let blocks = list_blocks(SAMPLE_PAGE);
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].0, "github.com - foo");
        assert_eq!(blocks[0].1.len(), 3);
        assert_eq!(blocks[0].1[0], ("username".to_string(), "foo".to_string()));
        assert_eq!(blocks[1].0, "github.com - bar");
    }

    #[test]
    fn patch_block_preserves_field_order() {
        // Add a new field — should append to end, not reshuffle existing fields.
        let fields = vec![("custom".to_string(), "x".to_string())];
        let res = patch_block(SAMPLE_PAGE, "github.com - foo", &fields, &[], false).unwrap();
        let idx_username = res.content.find("username: foo").unwrap();
        let idx_password = res.content.find("password: bar").unwrap();
        let idx_custom = res.content.find("custom: x").unwrap();
        assert!(idx_username < idx_password);
        assert!(idx_password < idx_custom);
    }

    /// A label ending in a backslash must never smuggle the block's values onto
    /// disk in plaintext.
    ///
    /// `escape_label` escaped `]` but not `\`, so a label of `svc\` was written
    /// as the line `:::secret[svc\]` — whose `]` the reader then treats as an
    /// escaped bracket. No unescaped `]` remained, `parse_secret_open` returned
    /// `None`, the open fence stopped matching, and `encrypt_secrets` walked
    /// straight past the block, leaving the password on disk as cleartext.
    #[test]
    fn label_ending_in_backslash_does_not_leak_the_value_in_plaintext() {
        let key = test_master_key();
        let created = patch_block(
            "",
            "svc\\",
            &[("password".to_string(), "hunter2-do-not-leak".to_string())],
            &[],
            true,
        )
        .expect("a trailing backslash in the label must be storable");

        let encrypted = encrypt_secrets(&created.content, &key).unwrap();
        assert!(
            !encrypted.contains("hunter2-do-not-leak"),
            "secret value written to disk in plaintext:\n{encrypted}"
        );
        assert!(
            encrypted.contains(ENC_PREFIX),
            "block was never encrypted:\n{encrypted}"
        );

        let decrypted = decrypt_secrets(&encrypted, &key).unwrap();
        assert!(
            decrypted.contains("hunter2-do-not-leak"),
            "value did not survive the round trip:\n{decrypted}"
        );
        assert_eq!(
            list_blocks(&decrypted)
                .first()
                .map(|(label, _)| label.as_str()),
            Some("svc\\"),
            "label did not round-trip:\n{decrypted}"
        );
    }

    /// Every label the block API accepts must survive `escape_label` →
    /// `parse_secret_open` unchanged. Backslashes and brackets are the whole
    /// risk surface: an escape that is not injective lets one label be written
    /// such that it reads back as a different one, or as no block at all.
    #[test]
    fn label_escaping_round_trips_for_backslashes_and_brackets() {
        let cases = [
            "plain",
            "svc\\",
            "\\",
            "\\\\",
            "a]b",
            "]",
            "[nested]",
            "mongodb.com[2]",
            "a\\]b",
            "back\\slash",
            "C:\\Users\\me",
            "trailing\\\\",
            "mixed\\]\\[x",
        ];
        for label in cases {
            let line = format!(":::secret[{}]", escape_label(label));
            assert_eq!(
                parse_secret_open(&line).as_deref(),
                Some(label),
                "label {label:?} did not round-trip through {line:?}"
            );
        }
    }

    /// Labels written by builds that escaped `]` but never escaped `\` must
    /// keep reading back exactly as they did before. This is what allows the
    /// escaping fix to ship without a file migration.
    #[test]
    fn reader_stays_compatible_with_pre_fix_label_escaping() {
        // `escape_label` as it was: `label.replace(']', "\\]")`.
        let legacy = |label: &str| format!(":::secret[{}]", label.replace(']', "\\]"));

        for label in [
            "plain",
            "a]b",
            "mongodb.com[2]",
            "C:\\Users\\me",
            "back\\slash",
        ] {
            assert_eq!(
                parse_secret_open(&legacy(label)).as_deref(),
                Some(label),
                "legacy-written label {label:?} no longer reads back"
            );
        }
    }

    /// `redact_secrets` is the ONLY thing standing between a Notes-scope token
    /// and a secret it is not allowed to read. It must therefore be impossible
    /// for a value to survive it, whatever shape the page is in.
    ///
    /// Two ways one used to:
    ///
    /// 1. It delegated to `transform_secrets`, which deliberately skips blocks
    ///    inside markdown code fences so documentation can show the syntax. A
    ///    fenced block is never encrypted, so its value is real cleartext — and
    ///    it was handed back verbatim.
    /// 2. It ended in `.unwrap_or_else(|_| content.to_string())`, so any error
    ///    returned the ORIGINAL page. The failure path was strictly less safe
    ///    than the success path.
    #[test]
    fn redaction_leaves_no_value_behind_in_any_block_shape() {
        let cases = [
            // Ordinary block.
            ":::secret[API]\npassword: leak-plain\n:::",
            // Inside a code fence — not encrypted on disk, so this is cleartext.
            "```markdown\n:::secret[API]\npassword: leak-fenced\n:::\n```",
            // Indented closing fence: Rust closes on the trimmed line.
            ":::secret[API]\npassword: leak-indented\n  :::",
            // Label with an escaped bracket.
            ":::secret[mongodb.com[2\\]]\npassword: leak-escaped\n:::",
            // Never closed — a page truncated mid-write.
            ":::secret[API]\npassword: leak-unclosed",
            // Encrypted body: still must not come through.
            ":::secret[API]\nenc:v1:AAAA-leak-ciphertext\n:::",
        ];

        for content in cases {
            let redacted = redact_secrets(content);
            for marker in [
                "leak-plain",
                "leak-fenced",
                "leak-indented",
                "leak-escaped",
                "leak-unclosed",
                "leak-ciphertext",
            ] {
                assert!(
                    !redacted.contains(marker),
                    "value survived redaction of {content:?}:\n{redacted}"
                );
            }
            assert!(
                redacted.contains("[REDACTED]"),
                "nothing was redacted in {content:?}:\n{redacted}"
            );
        }
    }

    /// Labels stay readable — they are plaintext on disk regardless, and the
    /// browser extension lists them to pick a credential. Only values go.
    #[test]
    fn redaction_keeps_labels_and_surrounding_markdown() {
        let content = "# Note\n\n:::secret[AWS prod]\npassword: leak-me\n:::\n\nTrailing text.";
        let redacted = redact_secrets(content);
        assert!(redacted.contains(":::secret[AWS prod]"));
        assert!(redacted.contains("# Note"));
        assert!(redacted.contains("Trailing text."));
        assert!(!redacted.contains("leak-me"));
    }

    #[test]
    fn block_states_tell_sealed_from_plaintext_empty_and_unclosed() {
        let content = "\
:::secret[sealed]
enc:v1:AAAA
:::
:::secret[plain]
password: hunter2
:::
:::secret[empty]
:::
```
:::secret[example]
password: shown-in-docs
:::
```
:::secret[unclosed]
password: hunter2";
        let states = secret_block_states(content);
        let summary: Vec<(&str, bool, bool, bool)> = states
            .iter()
            .map(|s| (s.label.as_str(), s.encrypted, s.empty, s.closed))
            .collect();
        assert_eq!(
            summary,
            vec![
                ("sealed", true, false, true),
                ("plain", false, false, true),
                ("empty", false, true, true),
                ("unclosed", false, false, false),
            ]
        );
    }
}
