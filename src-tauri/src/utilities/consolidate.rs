// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Consolidate scattered credential secrets into per-domain pages.
//!
//! Scans the chosen source folders, groups every secret block by the domain
//! parsed from its URL-like field (secrets without a URL land in an "other"
//! group), and can then merge each group into a single page under the target
//! folder (default `credentials`). Merging reads and decrypts each source
//! page's full content, concatenates it with source attributions, and
//! re-encrypts the secret blocks on save. A preview step ([`consolidate_preview`])
//! produces the plan without modifying anything, and a test mode leaves source
//! pages untouched so the result can be inspected before committing.

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::pages::crud;
use crate::pages::error::PageError;
use crate::pages::secret::{decrypt_secrets, encrypt_secrets};

use super::collect_all_pages;

/// One secret slated for consolidation, tagged with its derived domain.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConsolidateEntry {
    /// Title of the source page.
    pub page_title: String,
    /// Vault-relative path of the source page.
    pub page_path: String,
    /// Secret block label.
    pub label: String,
    /// Domain parsed from the secret's URL field, or "other".
    pub domain: String,
    /// Source page's last-updated timestamp (RFC 3339).
    pub updated_at: String,
}

/// All secrets that share one domain.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConsolidateGroup {
    /// The shared domain (or "other").
    pub domain: String,
    /// Secrets belonging to this domain.
    pub entries: Vec<ConsolidateEntry>,
}

/// Preview of a consolidation, produced without changing the vault.
#[derive(Debug, Serialize, Deserialize)]
pub struct ConsolidatePlan {
    /// Per-domain groups, sorted alphabetically with "other" last.
    pub groups: Vec<ConsolidateGroup>,
    /// Total secrets found across all groups.
    pub total_secrets: usize,
    /// How many pages were scanned to build the plan.
    pub total_pages_scanned: usize,
}

/// Progress event emitted while consolidation runs (for UI updates).
#[derive(Debug, Clone, Serialize)]
pub struct ConsolidateProgress {
    /// Index of the group currently being processed.
    pub current: usize,
    /// Total number of groups to process.
    pub total: usize,
    /// Domain of the group currently being processed.
    pub current_domain: String,
    /// Running count of pages created so far.
    pub pages_created: usize,
    /// Running count of secrets moved so far.
    pub secrets_moved: usize,
}

/// Final outcome of a completed consolidation run.
#[derive(Debug, Serialize)]
pub struct ConsolidateResult {
    /// New consolidated pages created.
    pub pages_created: usize,
    /// Existing target pages appended to.
    pub pages_merged: usize,
    /// Total secrets moved into consolidated pages.
    pub secrets_moved: usize,
    /// Source pages deleted (only in non-test mode).
    pub source_pages_deleted: usize,
    /// Source folders removed once emptied.
    pub source_folders_deleted: Vec<String>,
    /// Folders created to hold consolidated pages.
    pub folders_created: Vec<String>,
}

/// Extract domain from a URL string.
fn extract_domain(url: &str) -> Option<String> {
    let url = url.trim().to_lowercase();
    let without_protocol = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .unwrap_or(&url);
    let host = without_protocol.split('/').next()?;
    let host = host.split(':').next()?;
    if host.is_empty() {
        return None;
    }
    Some(host.to_string())
}

/// Parse a `:::secret[Label]` line, handling `\]` escapes.
/// Returns the unescaped label.
///
/// The closing `]` is the first `]` that is NOT preceded by `\`.
/// Inner `[` characters don't affect matching — only `\]` escapes matter.
fn parse_secret_label(line: &str) -> Option<String> {
    let trimmed = line.trim();
    let after = trimmed.strip_prefix(":::secret[")?;
    let bytes = after.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 1 < bytes.len() && bytes[i + 1] == b']' {
            i += 2; // skip escaped \]
            continue;
        }
        if bytes[i] == b']' {
            // Found the unescaped closing bracket
            let raw = &after[..i];
            return Some(raw.replace("\\]", "]"));
        }
        i += 1;
    }
    None
}

/// Parse decrypted content to find secrets with URL fields.
fn extract_secrets_with_urls(decrypted_content: &str) -> Vec<(String, Option<String>)> {
    let mut results = Vec::new();
    let mut in_secret = false;
    let mut current_label = String::new();
    let mut current_url: Option<String> = None;
    let mut in_code_fence = false;

    for line in decrypted_content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_code_fence = !in_code_fence;
            continue;
        }
        if in_code_fence {
            continue;
        }

        if let Some(label) = parse_secret_label(trimmed) {
            if in_secret {
                results.push((current_label.clone(), current_url.take()));
            }
            current_label = label;
            current_url = None;
            in_secret = true;
        } else if in_secret && trimmed == ":::" {
            results.push((current_label.clone(), current_url.take()));
            in_secret = false;
        } else if in_secret {
            if let Some(sep_pos) = trimmed.find(": ") {
                let k = trimmed[..sep_pos].trim().to_lowercase();
                let v = trimmed[sep_pos + 2..].trim().to_string();
                if (k == "url" || k == "site" || k == "domain" || k == "website")
                    && !v.is_empty()
                    && current_url.is_none()
                {
                    current_url = Some(v);
                }
            }
        }
    }
    if in_secret {
        results.push((current_label, current_url));
    }
    results
}

/// Scan source folders and group ALL secrets by domain.
pub fn consolidate_preview(
    vault_dir: &Path,
    master_key: &[u8],
    source_folders: &[String],
) -> Result<ConsolidatePlan, PageError> {
    let pages = collect_all_pages(vault_dir)?;
    let mut domain_groups: HashMap<String, Vec<ConsolidateEntry>> = HashMap::new();
    let mut total_secrets = 0usize;
    let mut total_pages_scanned = 0usize;

    for (rel_path, meta, content) in &pages {
        if !source_folders.is_empty() && !source_folders.contains(&meta.folder) {
            continue;
        }

        total_pages_scanned += 1;

        if !content.contains(":::secret[") {
            continue;
        }

        let decrypted = match decrypt_secrets(content, master_key) {
            Ok(d) => d,
            Err(_) => continue,
        };

        let secrets = extract_secrets_with_urls(&decrypted);
        for (label, url) in secrets {
            total_secrets += 1;
            let domain = url
                .as_ref()
                .and_then(|u| extract_domain(u))
                .unwrap_or_else(|| "other".to_string());

            domain_groups
                .entry(domain.clone())
                .or_default()
                .push(ConsolidateEntry {
                    page_title: meta.title.clone(),
                    page_path: rel_path.clone(),
                    label,
                    domain,
                    updated_at: meta.updated_at.to_rfc3339(),
                });
        }
    }

    let mut groups: Vec<ConsolidateGroup> = domain_groups
        .into_iter()
        .map(|(domain, entries)| ConsolidateGroup { domain, entries })
        .collect();

    groups.sort_by(|a, b| {
        if a.domain == "other" {
            return std::cmp::Ordering::Greater;
        }
        if b.domain == "other" {
            return std::cmp::Ordering::Less;
        }
        a.domain.cmp(&b.domain)
    });

    Ok(ConsolidatePlan {
        groups,
        total_secrets,
        total_pages_scanned,
    })
}

/// Default folder name for all consolidated pages.
pub const CONSOLIDATE_FOLDER: &str = "credentials";
/// Scratch folder used by test-mode consolidation so results can be inspected
/// without touching real pages; cleaned up by [`cleanup_test_folder`].
pub const TEST_FOLDER: &str = "_consolidate-test";

/// Ensure a target folder exists.
pub fn ensure_folder(vault_dir: &Path, folder: &str) -> Result<bool, PageError> {
    let target = if folder.is_empty() {
        CONSOLIDATE_FOLDER
    } else {
        folder
    };
    let folder_path = vault_dir.join(target);
    if !folder_path.exists() {
        std::fs::create_dir_all(&folder_path)?;
        Ok(true)
    } else {
        Ok(false)
    }
}

/// Clean up the test folder (delete all files in it).
pub fn cleanup_test_folder(vault_dir: &Path) -> Result<usize, PageError> {
    let test_path = vault_dir.join(TEST_FOLDER);
    if !test_path.is_dir() {
        return Ok(0);
    }
    let mut deleted = 0;
    for entry in walkdir::WalkDir::new(&test_path)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if entry.path().is_file() {
            std::fs::remove_file(entry.path())?;
            deleted += 1;
        }
    }
    // Remove empty dir
    let _ = std::fs::remove_dir_all(&test_path);
    Ok(deleted)
}

/// Find an existing page in a folder whose title matches (case-insensitive).
fn find_existing_page_by_title(
    vault_dir: &Path,
    folder: &str,
    title: &str,
) -> Option<(String, String)> {
    let folder_path = vault_dir.join(folder);
    if !folder_path.is_dir() {
        return None;
    }
    let title_lower = title.to_lowercase();
    for entry in walkdir::WalkDir::new(&folder_path)
        .max_depth(1)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if !path.is_file() || path.extension().is_none_or(|ext| ext != "md") {
            continue;
        }
        if let Ok(page) = crud::read_page(
            vault_dir,
            &format!("{}/{}", folder, path.file_name().unwrap().to_string_lossy()),
        ) {
            if page.meta.title.to_lowercase() == title_lower {
                return Some((page.path, page.content));
            }
        }
    }
    None
}

/// Execute consolidation for a single domain group.
///
/// For each source page that has secrets matching this domain:
/// 1. Read the FULL page content (encrypted)
/// 2. Decrypt ALL secrets in the page
/// 3. Build the consolidated page with ALL content (text + decrypted secrets)
/// 4. Re-encrypt secrets when saving
///
/// If `delete_source` is false (test mode), source pages are not modified.
pub fn consolidate_one_group(
    vault_dir: &Path,
    master_key: &[u8],
    group: &ConsolidateGroup,
    target_folder: &str,
    delete_source: bool,
) -> Result<(usize, usize), PageError> {
    if group.entries.is_empty() {
        return Ok((0, 0));
    }

    // Collect unique source pages for this domain group
    let mut seen_pages = std::collections::HashSet::new();
    let mut page_contents: Vec<(String, String)> = Vec::new(); // (title, full decrypted content)
    let mut secrets_count = 0usize;

    for entry in &group.entries {
        if !seen_pages.insert(entry.page_path.clone()) {
            // Already processed this page — just count the secret
            secrets_count += 1;
            continue;
        }

        let page = match crud::read_page(vault_dir, &entry.page_path) {
            Ok(p) => p,
            Err(_) => continue,
        };

        // Decrypt ALL secrets in the page to get full plaintext content
        let decrypted =
            decrypt_secrets(&page.content, master_key).unwrap_or_else(|_| page.content.clone());

        page_contents.push((page.meta.title.clone(), decrypted));
        secrets_count += 1;
    }

    if page_contents.is_empty() {
        return Ok((0, 0));
    }

    // Build consolidated content: each source page separated by ---
    let mut merged_content = String::new();

    for (i, (page_title, content)) in page_contents.iter().enumerate() {
        if i > 0 || find_existing_page_by_title(vault_dir, target_folder, &group.domain).is_some() {
            merged_content.push_str("\n---\n\n");
        }
        // Add source attribution
        merged_content.push_str(&format!("### From: {}\n\n", page_title));
        // Add the FULL content (text + secret blocks) — secrets are decrypted
        let trimmed = content.trim();
        if !trimmed.is_empty() {
            merged_content.push_str(trimmed);
            merged_content.push('\n');
        }
    }

    // Re-encrypt all secret blocks before saving
    let encrypted_content = encrypt_secrets(&merged_content, master_key)?;

    let title = group.domain.clone();
    let mut created = 0usize;

    // Check if a page with this title already exists in the target folder
    if let Some((existing_path, existing_content)) =
        find_existing_page_by_title(vault_dir, target_folder, &title)
    {
        // Don't merge into itself
        let is_self =
            group.entries.iter().any(|e| e.page_path == existing_path) && seen_pages.len() == 1;
        if is_self {
            return Ok((0, 0));
        }

        // Append to existing page
        let merged = format!(
            "{}\n{}",
            existing_content.trim_end(),
            encrypted_content.trim_end()
        );
        crud::update_page(vault_dir, &existing_path, &merged)?;
    } else {
        // Create new page
        let body = format!(
            "Credentials for **{}**.\n\n{}",
            group.domain,
            encrypted_content.trim_end()
        );
        let page = crud::create_page(vault_dir, &title, target_folder, &body, false)?;
        crud::update_tags(vault_dir, &page.path, vec!["consolidated".to_string()])?;
        created = 1;
    }

    // Remove secrets from source pages (only in full mode, not test mode)
    if delete_source {
        for page_path in &seen_pages {
            let page = match crud::read_page(vault_dir, page_path) {
                Ok(p) => p,
                Err(_) => continue,
            };

            // Check if page still has content worth keeping
            if !has_remaining_non_secret_content(&page.content) {
                // Page is entirely secrets — delete it
                let file_path = crud::safe_join(vault_dir, page_path)?;
                let _ = std::fs::remove_file(&file_path);
            }
            // If page has non-secret content, leave it (user can manually clean up)
        }
    }

    Ok((created, secrets_count))
}

/// Check if a page has any meaningful non-secret content.
fn has_remaining_non_secret_content(content: &str) -> bool {
    let mut in_code_fence = false;
    let mut in_secret = false;

    for line in content.lines() {
        let trimmed = line.trim();

        if (trimmed.starts_with("```") || trimmed.starts_with("~~~")) && !in_secret {
            in_code_fence = !in_code_fence;
        }

        if !in_code_fence && !in_secret && trimmed.starts_with(":::secret[") {
            in_secret = true;
            continue;
        }
        if in_secret {
            if trimmed == ":::" {
                in_secret = false;
            }
            continue;
        }

        // Skip empty lines and common boilerplate
        if !trimmed.is_empty()
            && !trimmed.starts_with("Imported from")
            && !trimmed.starts_with("fav:")
        {
            return true;
        }
    }
    false
}

/// Remove fully-consumed source pages (those left with no non-secret content
/// after their secrets were moved to the target) and delete a source folder only
/// once it is empty. Pages that still hold real notes are preserved.
pub fn cleanup_source_folders(
    vault_dir: &Path,
    source_folders: &[String],
    target_folder: &str,
) -> Result<(usize, Vec<String>), PageError> {
    let mut pages_deleted = 0usize;
    let mut folders_deleted = Vec::new();

    for folder in source_folders {
        if folder == target_folder {
            continue;
        }

        let folder_path = vault_dir.join(folder);
        if !folder_path.is_dir() {
            continue;
        }

        for entry in walkdir::WalkDir::new(&folder_path)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            let path = entry.path();
            if path.is_file() && path.extension().is_some_and(|ext| ext == "md") {
                // Only delete a source page whose secrets were fully consumed
                // (no remaining non-secret content). Pages the user still has
                // real notes in are PRESERVED — blanket-deleting every `.md`
                // here destroyed exactly the notes `consolidate_one_group`
                // deliberately kept. On read failure, fail safe and keep the
                // file. `has_remaining_non_secret_content` reads the `:::secret`
                // fence structure, so it works on the on-disk (encrypted) form.
                let keep = std::fs::read_to_string(path)
                    .map(|c| has_remaining_non_secret_content(&c))
                    .unwrap_or(true);
                if !keep && std::fs::remove_file(path).is_ok() {
                    pages_deleted += 1;
                }
            }
        }

        // Remove the source folder only if it is now empty — never while it
        // still holds preserved notes (or any other content).
        let is_empty = std::fs::read_dir(&folder_path)
            .map(|mut d| d.next().is_none())
            .unwrap_or(false);
        if is_empty && std::fs::remove_dir_all(&folder_path).is_ok() {
            folders_deleted.push(folder.clone());
        }
    }

    Ok((pages_deleted, folders_deleted))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleanup_preserves_pages_with_notes_and_only_removes_empty_folders() {
        // Regression: cleanup_source_folders used to blanket-delete every `.md`
        // and remove_dir_all the folder, destroying pages that still held real
        // notes. It must delete only fully-consumed (all-secret) pages and keep
        // folders that still contain preserved notes.
        let tmp = tempfile::tempdir().unwrap();
        let vault = tmp.path();

        // Folder A: one all-secret (consumed) page + one page with real notes.
        let folder_a = vault.join("creds-a");
        std::fs::create_dir_all(&folder_a).unwrap();
        std::fs::write(
            folder_a.join("consumed.md"),
            ":::secret[Login]\nenc:v1:abc\n:::\n",
        )
        .unwrap();
        std::fs::write(
            folder_a.join("keep.md"),
            "# Meeting notes\n\nRemember to rotate the key.\n",
        )
        .unwrap();

        // Folder B: only an all-secret page — should end up empty and removed.
        let folder_b = vault.join("creds-b");
        std::fs::create_dir_all(&folder_b).unwrap();
        std::fs::write(
            folder_b.join("only-secret.md"),
            ":::secret[Token]\nenc:v1:def\n:::\n",
        )
        .unwrap();

        let (deleted, folders) = cleanup_source_folders(
            vault,
            &["creds-a".to_string(), "creds-b".to_string()],
            "target",
        )
        .unwrap();

        // Two consumed pages deleted; the notes page survives.
        assert_eq!(deleted, 2);
        assert!(folder_a.join("keep.md").exists(), "notes page must survive");
        assert!(!folder_a.join("consumed.md").exists());
        assert!(folder_a.is_dir(), "folder with notes must be kept");
        // Folder B is now empty and removed.
        assert!(!folder_b.exists(), "emptied folder should be removed");
        assert_eq!(folders, vec!["creds-b".to_string()]);
    }

    #[test]
    fn test_extract_domain() {
        assert_eq!(
            extract_domain("https://github.com/user/repo"),
            Some("github.com".to_string())
        );
        assert_eq!(
            extract_domain("http://example.com:8080/path"),
            Some("example.com".to_string())
        );
        assert_eq!(extract_domain("github.com"), Some("github.com".to_string()));
        assert_eq!(extract_domain(""), None);
    }

    #[test]
    fn test_parse_secret_label() {
        assert_eq!(
            parse_secret_label(":::secret[Simple]"),
            Some("Simple".to_string())
        );
        assert_eq!(
            parse_secret_label(":::secret[akaunting.com[2\\]]"),
            Some("akaunting.com[2]".to_string())
        );
        assert_eq!(
            parse_secret_label(":::secret[test\\]label]"),
            Some("test]label".to_string())
        );
        assert_eq!(parse_secret_label("not a secret"), None);
    }

    #[test]
    fn test_extract_secrets_with_urls() {
        let content = ":::secret[GitHub]\nusername: john\npassword: abc123\nurl: https://github.com/login\n:::\n\n:::secret[No URL]\npassword: xyz\n:::";
        let results = extract_secrets_with_urls(content);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].0, "GitHub");
        assert_eq!(results[0].1.as_deref(), Some("https://github.com/login"));
        assert_eq!(results[1].0, "No URL");
        assert!(results[1].1.is_none());
    }
}
