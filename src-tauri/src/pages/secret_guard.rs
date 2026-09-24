// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Write-side guard against secrets landing on disk in plaintext.
//!
//! Every write that reaches the vault through the local API (and so through
//! MCP, the CLI, the SDKs and the browser extension) passes its content through
//! [`find_plaintext_secrets`] first. Anything inside a `:::secret[...]` block is
//! encrypted on save, so it is not scanned. Everything else is written to disk
//! exactly as given, and that is where a credential must never appear.
//!
//! The guard exists because of an incident, not a hypothetical: on 2026-08-26 a
//! live Stripe key was found sitting in a scratch page in cleartext, written by
//! an agent that had the value in hand and put it in a note instead of a block.
//! `find_secrets` indexed it identically to an encrypted one, so nothing flagged
//! it. Refusing the write is the only point at which that mistake is cheap.
//!
//! **What is detected.** Two kinds of evidence, both deliberately conservative
//! so the guard never blocks ordinary prose:
//!
//! 1. Well-known token shapes with a fixed prefix (`AKIA…`, `ghp_…`,
//!    `sk_live_…`, PEM private-key headers, JWTs, Claspt's own API tokens, and
//!    so on). A prefix match is close to certain and needs no other signal.
//! 2. A `key = value` line where the key is a secret-ish word (`password`,
//!    `token`, `api_key`, …) AND the value is long AND has the entropy of a
//!    generated credential AND is not an obvious placeholder or the name of an
//!    environment variable. All four are required. `password: see the vault`
//!    and `token: CLASPT_API_TOKEN` pass; `token: 8f3k…` does not.
//!
//! **What is reported.** Only the pattern name and the line number. The
//! matched value is never copied into a finding, an error message, or a log,
//! because the whole point is to keep it out of places it does not belong.
//!
//! Code fences are NOT skipped here. A `.env` sample inside a ``` block is the
//! most common way a key ends up in a note, and the secret-block parser treats
//! `:::secret` inside a fence as an example rather than a real block, so a
//! value there would be written unencrypted.

use std::sync::OnceLock;

use regex::Regex;

use super::secret::{parse_secret_open, FenceTracker};

/// One thing the guard found. Carries where and what kind, never the value.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct PlaintextFinding {
    /// Stable, machine-readable name of the pattern that matched.
    pub kind: &'static str,
    /// 1-based line number within the content that was scanned.
    pub line: usize,
}

/// A fixed-prefix token shape. Matching one of these is sufficient on its own.
struct KnownShape {
    kind: &'static str,
    pattern: &'static str,
}

/// Order matters only where one shape is a prefix of another (`sk-ant-` is
/// also matched by the OpenAI shape), so the more specific one comes first and
/// the scan stops at the first hit per line.
const KNOWN_SHAPES: &[KnownShape] = &[
    KnownShape {
        kind: "private-key-pem",
        pattern: r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----",
    },
    KnownShape {
        kind: "aws-access-key",
        pattern: r"\bAKIA[0-9A-Z]{16}\b",
    },
    KnownShape {
        kind: "github-token",
        pattern: r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b",
    },
    KnownShape {
        kind: "github-fine-grained-token",
        pattern: r"\bgithub_pat_[A-Za-z0-9_]{22,}\b",
    },
    KnownShape {
        kind: "stripe-key",
        pattern: r"\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{24,}\b",
    },
    KnownShape {
        kind: "anthropic-key",
        pattern: r"\bsk-ant-[A-Za-z0-9_-]{32,}\b",
    },
    KnownShape {
        kind: "openai-key",
        pattern: r"\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b",
    },
    KnownShape {
        kind: "slack-token",
        pattern: r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b",
    },
    KnownShape {
        kind: "google-api-key",
        pattern: r"\bAIza[0-9A-Za-z_-]{35}\b",
    },
    KnownShape {
        kind: "jwt",
        pattern: r"\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b",
    },
    KnownShape {
        kind: "claspt-api-token",
        pattern: r"\bcls[nsp]_[0-9a-f]{64}\b",
    },
    KnownShape {
        // `scheme://user:password@host` — a connection string with the
        // credential embedded, the usual way database URLs leak.
        kind: "connection-string-with-password",
        pattern: r"\b[a-z][a-z0-9+.-]*://[^\s/:@]+:[^\s/@]+@",
    },
];

/// `key = value` or `key: value` where the key names a secret. The value is
/// then judged separately by [`looks_generated`]; matching the key alone means
/// nothing.
const ASSIGNMENT_PATTERN: &str = r#"(?i)\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?key)\b\s*[:=]\s*["']?([^\s"']+)"#;

/// Below this many characters a value is too short to be a generated
/// credential worth refusing over; short passwords are caught by the
/// strength checker, not this guard.
const MIN_GENERIC_LEN: usize = 16;

/// Shannon entropy floor, in bits per character. English prose and identifier
/// names sit around 3.0; base64, hex and random alphanumerics sit above 3.5.
const MIN_ENTROPY_BITS_PER_CHAR: f64 = 3.5;

fn compiled() -> &'static (Vec<(&'static str, Regex)>, Regex) {
    static COMPILED: OnceLock<(Vec<(&'static str, Regex)>, Regex)> = OnceLock::new();
    COMPILED.get_or_init(|| {
        let shapes = KNOWN_SHAPES
            .iter()
            .map(|s| {
                (
                    s.kind,
                    Regex::new(s.pattern).expect("known-shape pattern is a compile-time constant"),
                )
            })
            .collect();
        let assignment =
            Regex::new(ASSIGNMENT_PATTERN).expect("assignment pattern is a compile-time constant");
        (shapes, assignment)
    })
}

/// Scan `content` for secrets that would be written to disk unencrypted.
///
/// Lines inside a real `:::secret[...]` block are skipped: they are encrypted on
/// save. Every other line is checked, including lines inside Markdown code
/// fences. At most one finding is reported per line.
pub fn find_plaintext_secrets(content: &str) -> Vec<PlaintextFinding> {
    let (shapes, assignment) = compiled();
    let mut findings = Vec::new();
    let mut fence = FenceTracker::new();
    let mut in_secret_block = false;

    for (index, line) in content.lines().enumerate() {
        if in_secret_block {
            if line.trim() == ":::" {
                in_secret_block = false;
            }
            continue;
        }
        if fence.observe(line) {
            continue;
        }
        if !fence.is_open() && parse_secret_open(line).is_some() {
            in_secret_block = true;
            continue;
        }

        let line_number = index + 1;
        if let Some((kind, _)) = shapes.iter().find(|(_, re)| re.is_match(line)) {
            findings.push(PlaintextFinding {
                kind,
                line: line_number,
            });
            continue;
        }
        if let Some(caps) = assignment.captures(line) {
            if let Some(value) = caps.get(1) {
                if looks_generated(value.as_str()) {
                    findings.push(PlaintextFinding {
                        kind: "credential-assignment",
                        line: line_number,
                    });
                }
            }
        }
    }

    findings
}

/// Whether a value on a `key = value` line has the shape of a real credential
/// rather than a placeholder, a reference, or the name of where to find one.
fn looks_generated(value: &str) -> bool {
    if value.chars().count() < MIN_GENERIC_LEN {
        return false;
    }
    if is_placeholder(value) || is_env_var_name(value) || is_reference(value) {
        return false;
    }
    shannon_entropy_bits_per_char(value) >= MIN_ENTROPY_BITS_PER_CHAR
}

/// `<your-key-here>`, `${TOKEN}`, `{{ token }}`, `xxxxxxxx`, `***`.
fn is_placeholder(value: &str) -> bool {
    let v = value.trim();
    (v.starts_with('<') && v.ends_with('>'))
        || v.starts_with("${")
        || v.starts_with("{{")
        || v.chars()
            .all(|c| c == 'x' || c == 'X' || c == '*' || c == '.')
}

/// `CLASPT_API_TOKEN`, `AWS_SECRET_ACCESS_KEY`: the name of a variable, not
/// its contents. Upper-case letters, digits and underscores only.
fn is_env_var_name(value: &str) -> bool {
    value.contains('_')
        && value
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
}

/// `claspt://...` and `op://...` are pointers to a secret, which is exactly
/// what an agent should be writing instead of the value.
fn is_reference(value: &str) -> bool {
    value.starts_with("claspt://") || value.starts_with("op://")
}

fn shannon_entropy_bits_per_char(value: &str) -> f64 {
    let mut counts = std::collections::HashMap::<char, usize>::new();
    let mut total = 0usize;
    for c in value.chars() {
        *counts.entry(c).or_insert(0) += 1;
        total += 1;
    }
    if total == 0 {
        return 0.0;
    }
    let total_f = total as f64;
    counts
        .values()
        .map(|&n| {
            let p = n as f64 / total_f;
            -p * p.log2()
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(content: &str) -> Vec<(&'static str, usize)> {
        find_plaintext_secrets(content)
            .into_iter()
            .map(|f| (f.kind, f.line))
            .collect()
    }

    #[test]
    fn known_shapes_are_found_with_line_numbers() {
        let claspt_token = format!("clss_{}", "ab".repeat(32));
        let content = format!(
            "\
# Deploy notes
AWS key: AKIAIOSFODNN7EXAMPLE
github: ghp_0123456789abcdefghijklmnopqrstuvwxyzABCDEF
stripe sk_test_4eC39HqLyjWDarjtT1zdp7dc
-----BEGIN RSA PRIVATE KEY-----
token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U
mine {claspt_token}"
        );
        let found = kinds(&content);
        assert_eq!(
            found,
            vec![
                ("aws-access-key", 2),
                ("github-token", 3),
                ("stripe-key", 4),
                ("private-key-pem", 5),
                ("jwt", 6),
                ("claspt-api-token", 7),
            ]
        );
    }

    #[test]
    fn anthropic_key_is_not_misreported_as_openai() {
        let content = format!("key sk-ant-{}", "a1".repeat(20));
        assert_eq!(kinds(&content), vec![("anthropic-key", 1)]);
        let content = format!("key sk-proj-{}", "a1".repeat(20));
        assert_eq!(kinds(&content), vec![("openai-key", 1)]);
    }

    #[test]
    fn connection_string_with_embedded_password_is_found() {
        assert_eq!(
            kinds("DATABASE_URL=postgres://app:s3cr3tpass@db.internal:5432/app"),
            vec![("connection-string-with-password", 1)]
        );
        // No credential in the URL: nothing to report.
        assert!(kinds("see https://docs.example.com/setup").is_empty());
    }

    #[test]
    fn values_inside_a_real_secret_block_are_not_scanned() {
        let content = "\
intro
:::secret[AWS]
access_key: AKIAIOSFODNN7EXAMPLE
password: 8f3kQz9vLm2xR7tYw4nB
:::
outro";
        assert!(kinds(content).is_empty());
    }

    #[test]
    fn a_secret_block_example_inside_a_code_fence_is_scanned() {
        // The block parser treats this as an example and never encrypts it, so
        // the value would reach disk as-is. The guard must see through the fence.
        let content = "\
```markdown
:::secret[AWS]
access_key: AKIAIOSFODNN7EXAMPLE
:::
```";
        assert_eq!(kinds(content), vec![("aws-access-key", 3)]);
    }

    #[test]
    fn env_samples_inside_code_fences_are_scanned() {
        let content = "```env\nSTRIPE_KEY=sk_test_4eC39HqLyjWDarjtT1zdp7dc\n```";
        assert_eq!(kinds(content), vec![("stripe-key", 2)]);
    }

    #[test]
    fn generic_assignment_needs_length_entropy_and_no_placeholder() {
        // A generated-looking value: refused.
        assert_eq!(
            kinds("password: kQ9vLm2xR7tYw4nB8f3zJp6s"),
            vec![("credential-assignment", 1)]
        );
        // Prose, an env-var name, placeholders and references: allowed.
        for allowed in [
            "password: stored in the vault under Stripe",
            "token = CLASPT_API_TOKEN",
            "api_key: <your-api-key-here>",
            "secret: ${STRIPE_SECRET}",
            "token: {{ vault.token }}",
            "password: xxxxxxxxxxxxxxxxxxxx",
            "api_key: claspt://stripe/live-key",
            "password: short1",
            "the password field is required",
        ] {
            assert!(kinds(allowed).is_empty(), "should allow: {allowed}");
        }
    }

    #[test]
    fn one_finding_per_line_and_lines_after_an_unterminated_block_are_skipped() {
        // Two shapes on one line: the first shape in table order wins.
        assert_eq!(
            kinds("AKIAIOSFODNN7EXAMPLE and sk_test_4eC39HqLyjWDarjtT1zdp7dc"),
            vec![("aws-access-key", 1)]
        );
        // An unterminated block swallows the rest of the page, which mirrors
        // how the encryptor treats it; the audit reports that block itself.
        let content = ":::secret[open]\nAKIAIOSFODNN7EXAMPLE\nmore";
        assert!(kinds(content).is_empty());
    }

    #[test]
    fn findings_never_carry_the_value() {
        let secret = "AKIAIOSFODNN7EXAMPLE";
        let found = find_plaintext_secrets(&format!("k {secret}"));
        let rendered = format!("{found:?}");
        assert!(!rendered.contains(secret));
    }

    #[test]
    fn entropy_floor_separates_prose_from_generated() {
        assert!(shannon_entropy_bits_per_char("kQ9vLm2xR7tYw4nB8f3zJp6s") >= 3.5);
        assert!(shannon_entropy_bits_per_char("aaaaaaaaaaaaaaaaaaaa") < 1.0);
        assert!(shannon_entropy_bits_per_char("") == 0.0);
    }
}
