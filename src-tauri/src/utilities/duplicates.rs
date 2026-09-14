// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Detect duplicate / near-duplicate credentials across the vault.
//!
//! Extracts each secret block's label plus username- and URL-like fields, then
//! clusters entries that look like the same account using fuzzy matching
//! (Jaro-Winkler similarity on labels and URLs, with a lower label threshold
//! when usernames match exactly). Only clusters with more than one member are
//! reported, so the user can consolidate or update reused logins.

use super::collect_all_pages;
use crate::pages::error::PageError;
use crate::pages::secret::decrypt_secrets;
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;

/// A single credential considered for duplicate grouping.
#[derive(Debug, Clone, Serialize)]
pub struct DuplicateEntry {
    /// Title of the page the secret lives on.
    pub page_title: String,
    /// Vault-relative path of that page.
    pub page_path: String,
    /// Secret block label.
    pub label: String,
    /// Username/email-like field, if present.
    pub username: Option<String>,
    /// URL/site/domain-like field, if present.
    pub url: Option<String>,
}

/// A cluster of entries judged to refer to the same account.
#[derive(Debug, Serialize)]
pub struct DuplicateGroup {
    /// Representative key for the group (the first entry's label).
    pub key: String,
    /// The two or more entries in this cluster.
    pub entries: Vec<DuplicateEntry>,
}

/// All duplicate clusters found in the vault.
#[derive(Debug, Serialize)]
pub struct DuplicateReport {
    /// Clusters, each with more than one entry.
    pub groups: Vec<DuplicateGroup>,
}

/// Extract fields from a decrypted secret block.
fn extract_fields(block_content: &str) -> HashMap<String, String> {
    let mut fields = HashMap::new();
    for line in block_content.lines() {
        if let Some((key, value)) = line.split_once(':') {
            let k = key.trim().to_lowercase();
            let v = value.trim().to_string();
            if !v.is_empty() {
                fields.insert(k, v);
            }
        }
    }
    fields
}

/// Parse decrypted content to extract secret blocks with their fields.
fn extract_secret_blocks(decrypted_content: &str) -> Vec<(String, HashMap<String, String>)> {
    let mut results = Vec::new();
    let mut in_secret = false;
    let mut current_label = String::new();
    let mut block_content = String::new();
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

        if trimmed.starts_with(":::secret[") && trimmed.contains(']') {
            let start = ":::secret[".len();
            if let Some(end) = trimmed[start..].find(']') {
                current_label = trimmed[start..start + end].to_string();
                block_content.clear();
                in_secret = true;
            }
        } else if in_secret && trimmed == ":::" {
            let fields = extract_fields(&block_content);
            results.push((current_label.clone(), fields));
            in_secret = false;
        } else if in_secret {
            if !block_content.is_empty() {
                block_content.push('\n');
            }
            block_content.push_str(line);
        }
    }
    results
}

/// Scan the vault and group credentials that appear to be duplicates.
/// `master_key` decrypts secret blocks in memory; undecryptable pages are
/// skipped. The result contains only clusters with two or more members.
pub fn find_duplicates(vault_dir: &Path, master_key: &[u8]) -> Result<DuplicateReport, PageError> {
    let pages = collect_all_pages(vault_dir)?;
    let mut all_entries: Vec<DuplicateEntry> = Vec::new();

    for (rel_path, meta, content) in &pages {
        if !content.contains(":::secret[") {
            continue;
        }

        let decrypted = match decrypt_secrets(content, master_key) {
            Ok(d) => d,
            Err(_) => continue,
        };

        let blocks = extract_secret_blocks(&decrypted);
        for (label, fields) in blocks {
            all_entries.push(DuplicateEntry {
                page_title: meta.title.clone(),
                page_path: rel_path.clone(),
                label,
                username: fields
                    .get("username")
                    .or(fields.get("user"))
                    .or(fields.get("email"))
                    .cloned(),
                url: fields
                    .get("url")
                    .or(fields.get("site"))
                    .or(fields.get("domain"))
                    .cloned(),
            });
        }
    }

    // Group by fuzzy-matching labels and URLs
    let mut groups: Vec<DuplicateGroup> = Vec::new();
    let mut assigned: Vec<bool> = vec![false; all_entries.len()];

    for i in 0..all_entries.len() {
        if assigned[i] {
            continue;
        }
        let mut cluster = vec![all_entries[i].clone()];
        assigned[i] = true;

        for j in (i + 1)..all_entries.len() {
            if assigned[j] {
                continue;
            }
            if is_duplicate(&all_entries[i], &all_entries[j]) {
                cluster.push(all_entries[j].clone());
                assigned[j] = true;
            }
        }

        if cluster.len() > 1 {
            let key = cluster[0].label.clone();
            groups.push(DuplicateGroup {
                key,
                entries: cluster,
            });
        }
    }

    Ok(DuplicateReport { groups })
}

fn is_duplicate(a: &DuplicateEntry, b: &DuplicateEntry) -> bool {
    // Check label similarity
    let label_sim = strsim::jaro_winkler(&a.label.to_lowercase(), &b.label.to_lowercase());
    if label_sim >= 0.85 {
        return true;
    }

    // Check URL similarity (if both have URLs)
    if let (Some(url_a), Some(url_b)) = (&a.url, &b.url) {
        let url_sim = strsim::jaro_winkler(&url_a.to_lowercase(), &url_b.to_lowercase());
        if url_sim >= 0.85 {
            return true;
        }
    }

    // Check username + similar label combo
    if let (Some(user_a), Some(user_b)) = (&a.username, &b.username) {
        if user_a.to_lowercase() == user_b.to_lowercase() && label_sim >= 0.7 {
            return true;
        }
    }

    false
}
