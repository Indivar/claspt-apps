// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Page model: the YAML frontmatter ([`PageMeta`]) and whole-page ([`Page`])
//! types plus the parse/serialize helpers that turn a `.md` file into
//! `(metadata, content)` and back. Key invariant: the frontmatter is the
//! authoritative metadata store, and `parse_page` bounds its size and rejects
//! stray control characters so a malicious or corrupt file cannot OOM or confuse
//! the YAML parser.
use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Page metadata stored in YAML frontmatter.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PageMeta {
    /// Stable unique page identifier.
    pub id: String,
    /// Human-readable page title (also drives the filename slug).
    pub title: String,
    /// When the page was first created (UTC).
    pub created_at: DateTime<Utc>,
    /// When the page was last modified (UTC).
    pub updated_at: DateTime<Utc>,
    /// Whether the page is pinned to the top of the sidebar.
    #[serde(default)]
    pub pinned: bool,
    /// Whether the page is archived (hidden from the default list).
    #[serde(default)]
    pub archived: bool,
    /// Free-form tags for filtering and search.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    /// Vault folder the page lives in (e.g. "general").
    #[serde(default)]
    pub folder: String,
    /// Whether the page body is stored fully encrypted (as one `enc:v1:` blob).
    #[serde(default)]
    pub encrypted: bool,
    /// Agent namespace for memory pages (e.g. "claude-code").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_ns: Option<String>,
    /// Memory type: "persistent", "session", or "ephemeral".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_type: Option<String>,
    /// Time-to-live in hours (0 = permanent). Cleaned up by background task.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttl_hours: Option<u64>,
    /// Arbitrary key-value metadata for agent use.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_meta: Option<HashMap<String, String>>,
    /// The API client that last wrote this page (memory pages). Flat scalars
    /// rather than a nested map so every frontmatter reader, including the
    /// line-based one on mobile, carries them through unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub written_by_client: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub written_by_name: Option<String>,
    /// Memory kind: "episodic" (what happened), "semantic" (facts and
    /// decisions) or "procedural" (how we do things). Decides default
    /// retention and how a reader should weigh the page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_kind: Option<String>,
    /// When the memory became true. Absent means "since it was written".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub valid_from: Option<DateTime<Utc>>,
    /// When the memory stopped being true. A past value marks it stale.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub valid_until: Option<DateTime<Utc>>,
    /// Title of the memory that replaced this one; set on the old page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub superseded_by: Option<String>,
    /// When someone last confirmed the memory is still true.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verified_on: Option<DateTime<Utc>>,
    /// Whether the vault owner has looked at what an API client wrote here.
    /// Every client write sets it to `false`; only the app sets it to `true`.
    /// Readers over the API get unreviewed content inside data markers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reviewed: Option<bool>,
}

/// A full page: metadata + markdown content + file path.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Page {
    /// Frontmatter metadata for this page.
    pub meta: PageMeta,
    /// Markdown body below the frontmatter (may contain `enc:v1:` secret blocks).
    pub content: String,
    /// Relative path from vault root (e.g. "general/2026-02-21-143000-my-note.md").
    pub path: String,
}

/// Summary for sidebar list (no content body).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PageSummary {
    /// Frontmatter metadata for this page.
    pub meta: PageMeta,
    /// Relative path from vault root.
    pub path: String,
    /// First ~200 chars of content for preview.
    pub snippet: String,
}

/// A secret block summary: label + which page it belongs to.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecretSummary {
    /// The secret block label (e.g. "API Key").
    pub label: String,
    /// Title of the page containing this secret.
    pub page_title: String,
    /// Relative path to the page.
    pub page_path: String,
    /// Folder the page is in.
    pub folder: String,
    /// Page creation timestamp (for sorting).
    pub created_at: DateTime<Utc>,
}

const FRONTMATTER_DELIMITER: &str = "---";

/// Maximum size of YAML frontmatter to prevent OOM on malicious files.
const MAX_FRONTMATTER_SIZE: usize = 64 * 1024; // 64 KB

/// Parse a markdown file with YAML frontmatter into (PageMeta, content).
pub fn parse_page(raw: &str) -> Result<(PageMeta, String), super::error::PageError> {
    let trimmed = raw.trim_start();
    if !trimmed.starts_with(FRONTMATTER_DELIMITER) {
        return Err(super::error::PageError::InvalidFrontmatter(
            "missing opening ---".into(),
        ));
    }

    let after_first = &trimmed[FRONTMATTER_DELIMITER.len()..];
    let end_pos = after_first
        .find(&format!("\n{FRONTMATTER_DELIMITER}"))
        .ok_or_else(|| super::error::PageError::InvalidFrontmatter("missing closing ---".into()))?;

    let yaml_str = &after_first[..end_pos];

    // Reject oversized frontmatter
    if yaml_str.len() > MAX_FRONTMATTER_SIZE {
        return Err(super::error::PageError::InvalidFrontmatter(format!(
            "frontmatter too large ({} bytes, max {})",
            yaml_str.len(),
            MAX_FRONTMATTER_SIZE
        )));
    }

    // Reject control characters (except \n, \r, \t) that could cause parsing issues
    if yaml_str
        .chars()
        .any(|c| c.is_control() && c != '\n' && c != '\r' && c != '\t')
    {
        return Err(super::error::PageError::InvalidFrontmatter(
            "frontmatter contains invalid control characters".into(),
        ));
    }

    let content_start = end_pos + 1 + FRONTMATTER_DELIMITER.len();
    let content = after_first[content_start..].trim_start_matches('\n');

    let meta: PageMeta = serde_yaml::from_str(yaml_str)?;
    Ok((meta, content.to_string()))
}

/// Serialize a page to markdown with YAML frontmatter.
pub fn serialize_page(meta: &PageMeta, content: &str) -> Result<String, super::error::PageError> {
    let yaml = serde_yaml::to_string(meta).map_err(|e| {
        super::error::PageError::InvalidFrontmatter(format!("YAML serialization failed: {e}"))
    })?;
    Ok(format!("---\n{yaml}---\n{content}"))
}

/// Generate a filename from a title: YYYY-MM-DD-HHMMSS-title-slug.md
pub fn generate_filename(title: &str, timestamp: &DateTime<Utc>) -> String {
    let date_part = timestamp.format("%Y-%m-%d-%H%M%S");
    let slug_part = slug::slugify(title);
    let slug_truncated = if slug_part.len() > 60 {
        // Snap to a valid UTF-8 char boundary to avoid panicking on multi-byte slugs
        let mut end = 60;
        while end > 0 && !slug_part.is_char_boundary(end) {
            end -= 1;
        }
        &slug_part[..end]
    } else {
        &slug_part
    };
    format!("{}-{}.md", date_part, slug_truncated)
}

/// Extract a snippet from content (first ~200 chars, secret blocks masked).
pub fn make_snippet(content: &str, max_len: usize) -> String {
    // Full-body encrypted pages show a placeholder
    if content.trim().starts_with("enc:v1:") {
        return "[Encrypted page]".to_string();
    }

    let mut snippet = String::with_capacity(max_len);
    let mut in_secret = false;

    for line in content.lines() {
        if line.starts_with(":::secret") {
            in_secret = true;
            snippet.push_str("[secret]");
            snippet.push(' ');
            continue;
        }
        if in_secret {
            if line.starts_with(":::") && !line.starts_with(":::secret") {
                in_secret = false;
            }
            continue;
        }
        if !line.trim().is_empty() {
            if !snippet.is_empty() {
                snippet.push(' ');
            }
            snippet.push_str(line.trim());
        }
        if snippet.len() >= max_len {
            // Snap to a valid UTF-8 char boundary to avoid panicking on multi-byte content
            let mut end = max_len;
            while end > 0 && !snippet.is_char_boundary(end) {
                end -= 1;
            }
            snippet.truncate(end);
            break;
        }
    }

    snippet
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_and_serialize_roundtrip() {
        let now = Utc::now();
        let meta = PageMeta {
            id: "abc-123".to_string(),
            title: "Test Page".to_string(),
            created_at: now,
            updated_at: now,
            pinned: false,
            archived: false,
            tags: vec!["tag1".to_string()],
            folder: "general".to_string(),
            encrypted: false,
            agent_ns: None,
            memory_type: None,
            ttl_hours: None,
            custom_meta: None,
            written_by_client: None,
            written_by_name: None,
            memory_kind: None,
            valid_from: None,
            valid_until: None,
            superseded_by: None,
            verified_on: None,
            reviewed: None,
        };
        let content = "# Hello\n\nSome content here.";
        let serialized = serialize_page(&meta, content).unwrap();
        let (parsed_meta, parsed_content) = parse_page(&serialized).unwrap();

        assert_eq!(parsed_meta.id, meta.id);
        assert_eq!(parsed_meta.title, meta.title);
        assert_eq!(parsed_content, content);
    }

    #[test]
    fn generate_filename_format() {
        let ts = DateTime::parse_from_rfc3339("2026-02-21T14:30:00Z")
            .unwrap()
            .to_utc();
        let filename = generate_filename("My Test Page", &ts);
        assert_eq!(filename, "2026-02-21-143000-my-test-page.md");
    }

    #[test]
    fn snippet_masks_secrets() {
        let content = "Some text\n:::secret[Password]\nmy-secret-value\n:::\nMore text";
        let snippet = make_snippet(content, 200);
        assert!(snippet.contains("[secret]"));
        assert!(!snippet.contains("my-secret-value"));
        assert!(snippet.contains("More text"));
    }

    #[test]
    fn snippet_truncates() {
        let content = "A ".repeat(200);
        let snippet = make_snippet(&content, 50);
        assert!(snippet.len() <= 50);
    }

    #[test]
    fn snippet_with_emoji_does_not_panic() {
        // Regression: truncate at multi-byte UTF-8 boundary caused crash
        let content = "Hello 😀 world 🌍 this is a test with emoji 🎉 and more text";
        let snippet = make_snippet(content, 15);
        assert!(snippet.len() <= 18); // may be up to 3 extra bytes for char boundary snap
        assert!(!snippet.is_empty());
    }

    #[test]
    fn snippet_with_cjk_does_not_panic() {
        let content = "这是一个测试内容，包含中文字符和更多文字来填充";
        let snippet = make_snippet(content, 10);
        assert!(!snippet.is_empty());
    }

    #[test]
    fn snippet_with_accented_chars_does_not_panic() {
        let content = "café résumé naïve über straße coöperate some text";
        let snippet = make_snippet(content, 12);
        assert!(!snippet.is_empty());
    }
}
