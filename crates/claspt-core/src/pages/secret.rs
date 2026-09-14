// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Secret block parsing and encryption. A secret block is a markdown fence of
//! the form `:::secret[Label]` … body … `:::`; on save the body is sealed under
//! the master key and rewritten as an `enc:v1:<base64>` blob, and on read that
//! blob is decrypted back to plaintext. Key invariant: the transform is
//! scoped strictly to real secret fences — the `Label` is left untouched (it
//! stays searchable) and any `:::secret` appearing inside a fenced code block is
//! treated as a literal example and never encrypted, decrypted, or re-encrypted.
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
        let plaintext = vault_key::decrypt_block(master_key, encoded)
            .map_err(|e| PageError::Crypto(e.to_string()))?;
        Ok(plaintext.to_string())
    })
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

/// Check if a line opens a secret block, returning the label if so.
///
/// Handles escaped brackets: `:::secret[mongodb.com[2\]]` → label `mongodb.com[2]`.
/// The `\]` escape sequence is unescaped in the returned label.
fn parse_secret_open(line: &str) -> Option<String> {
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
fn is_code_fence(line: &str) -> bool {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::aead;

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
    fn wrong_key_fails_decrypt() {
        let key1 = test_master_key();
        let key2 = test_master_key();
        let content = ":::secret[Test]\nsecret value\n:::";

        let encrypted = encrypt_secrets(content, &key1).unwrap();
        let result = decrypt_secrets(&encrypted, &key2);
        assert!(result.is_err());
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

    /// The label reader must agree with the desktop crate's `escape_label`,
    /// which escapes `\` as `\\` and `]` as `\]`. Mobile reads secrets through
    /// this crate, so a divergence here means a block written on desktop is
    /// unreadable on the phone — or worse, silently unrecognised, which is how
    /// a value ends up on disk in plaintext.
    #[test]
    fn reads_labels_escaped_by_the_desktop_writer() {
        // Mirror of `escape_label` in `src-tauri/src/pages/secret.rs`.
        let escape = |label: &str| label.replace('\\', "\\\\").replace(']', "\\]");

        for label in [
            "plain",
            "svc\\",
            "\\",
            "a]b",
            "]",
            "mongodb.com[2]",
            "a\\]b",
            "C:\\Users\\me",
        ] {
            let line = format!(":::secret[{}]", escape(label));
            assert_eq!(
                parse_secret_open(&line).as_deref(),
                Some(label),
                "label {label:?} did not round-trip through {line:?}"
            );
        }
    }

    /// Labels written before the escaping fix — `]` escaped, `\` left raw —
    /// must keep reading back unchanged, so no file migration is needed.
    #[test]
    fn reads_labels_escaped_by_pre_fix_builds() {
        let legacy = |label: &str| format!(":::secret[{}]", label.replace(']', "\\]"));

        for label in ["plain", "a]b", "mongodb.com[2]", "C:\\Users\\me"] {
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
}
