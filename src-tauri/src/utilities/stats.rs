// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Vault composition statistics.
//!
//! Walks every page once to tally page/folder/secret/tag counts, on-disk size,
//! the per-folder page distribution, the average number of secrets per page,
//! and the 20 most-used tags. Only counts secret *labels* (via
//! `extract_secret_labels`), so no decryption is needed.

use super::collect_all_pages;
use crate::pages::error::PageError;
use crate::pages::secret::extract_secret_labels;
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;

/// Summary counts describing the shape of the vault.
#[derive(Debug, Serialize)]
pub struct VaultStats {
    /// Number of pages in the vault.
    pub total_pages: usize,
    /// Number of distinct folders that contain pages.
    pub total_folders: usize,
    /// Total secret blocks across all pages.
    pub total_secrets: usize,
    /// Number of distinct tags in use.
    pub total_tags: usize,
    /// Combined on-disk size of all page files, in bytes.
    pub total_size_bytes: u64,
    /// Page count keyed by folder.
    pub pages_by_folder: HashMap<String, usize>,
    /// Mean secrets per page (0.0 when the vault is empty).
    pub avg_secrets_per_page: f64,
    /// Up to 20 most-used tags as `(tag, count)`, sorted by count descending.
    pub top_tags: Vec<(String, usize)>,
}

/// Compute [`VaultStats`] by scanning all pages in `vault_dir`.
pub fn vault_stats(vault_dir: &Path) -> Result<VaultStats, PageError> {
    let pages = collect_all_pages(vault_dir)?;

    let mut folders: HashMap<String, usize> = HashMap::new();
    let mut tag_counts: HashMap<String, usize> = HashMap::new();
    let mut total_secrets = 0usize;
    let mut total_size: u64 = 0;

    for (rel_path, meta, content) in &pages {
        // Count by folder
        *folders.entry(meta.folder.clone()).or_default() += 1;

        // Count tags
        for tag in &meta.tags {
            *tag_counts.entry(tag.clone()).or_default() += 1;
        }

        // Count secrets
        let labels = extract_secret_labels(content);
        total_secrets += labels.len();

        // File size
        let full_path = vault_dir.join(rel_path);
        if let Ok(m) = std::fs::metadata(&full_path) {
            total_size += m.len();
        }
    }

    let total_pages = pages.len();
    let total_folders = folders.len();
    let total_tags = tag_counts.len();
    let avg_secrets = if total_pages > 0 {
        total_secrets as f64 / total_pages as f64
    } else {
        0.0
    };

    // Top tags sorted by count desc
    let mut top_tags: Vec<(String, usize)> = tag_counts.into_iter().collect();
    top_tags.sort_by_key(|t| std::cmp::Reverse(t.1));
    top_tags.truncate(20);

    Ok(VaultStats {
        total_pages,
        total_folders,
        total_secrets,
        total_tags,
        total_size_bytes: total_size,
        pages_by_folder: folders,
        avg_secrets_per_page: avg_secrets,
        top_tags,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn create_test_vault(dir: &Path) {
        let general = dir.join("general");
        fs::create_dir_all(&general).unwrap();
        fs::create_dir_all(dir.join(".securenotes")).unwrap();

        let page1 = "---\nid: \"1\"\ntitle: \"Test Page\"\ncreated_at: \"2026-01-01T00:00:00Z\"\nupdated_at: \"2026-01-01T00:00:00Z\"\ntags:\n  - api\n  - work\nfolder: general\n---\n# Test\n\n:::secret[API Key]\nenc:v1:abc123\n:::\n\n:::secret[Password]\nenc:v1:def456\n:::";
        fs::write(general.join("2026-01-01-000000-test-page.md"), page1).unwrap();

        let page2 = "---\nid: \"2\"\ntitle: \"Another Page\"\ncreated_at: \"2026-01-02T00:00:00Z\"\nupdated_at: \"2026-01-02T00:00:00Z\"\ntags:\n  - api\nfolder: general\n---\n# Another\n\nNo secrets here.";
        fs::write(general.join("2026-01-02-000000-another-page.md"), page2).unwrap();
    }

    #[test]
    fn test_vault_stats() {
        let tmp = TempDir::new().unwrap();
        create_test_vault(tmp.path());

        let stats = vault_stats(tmp.path()).unwrap();
        assert_eq!(stats.total_pages, 2);
        assert_eq!(stats.total_secrets, 2);
        assert_eq!(stats.total_folders, 1);
        assert_eq!(stats.total_tags, 2); // "api" and "work"
        assert!(stats.avg_secrets_per_page > 0.0);
        assert!(!stats.top_tags.is_empty());
    }
}
