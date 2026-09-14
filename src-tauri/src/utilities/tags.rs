// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Tag inventory and bulk tag editing across the vault.
//!
//! [`list_tags_usage`] tallies which pages carry each tag, and
//! [`bulk_tag_operation`] applies a rename, delete, or merge to every page's
//! frontmatter tags at once (deduplicating the result). Operations touch only
//! page metadata, never secret contents.

use super::collect_all_pages;
use crate::pages::crud;
use crate::pages::error::PageError;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

/// Usage of a single tag across the vault.
#[derive(Debug, Serialize)]
pub struct TagUsage {
    /// The tag name.
    pub tag: String,
    /// Number of pages carrying the tag.
    pub count: usize,
    /// Vault-relative paths of those pages.
    pub pages: Vec<String>,
}

/// A bulk tag edit to apply across all pages. Deserialized from the frontend
/// with a `"type"` discriminator (`rename` / `delete` / `merge`).
#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum TagOperation {
    /// Rename tag `from` to `to` wherever it appears.
    #[serde(rename = "rename")]
    Rename { from: String, to: String },
    /// Remove tag `tag` from every page.
    #[serde(rename = "delete")]
    Delete { tag: String },
    /// Merge tag `from` into `into`, collapsing duplicates.
    #[serde(rename = "merge")]
    Merge { from: String, into: String },
}

/// Result of a bulk tag operation.
#[derive(Debug, Serialize)]
pub struct BulkTagResult {
    /// Number of pages whose tags were modified.
    pub affected_pages: usize,
}

/// List every tag in the vault with its page count and pages, sorted by count
/// descending.
pub fn list_tags_usage(vault_dir: &Path) -> Result<Vec<TagUsage>, PageError> {
    let pages = collect_all_pages(vault_dir)?;
    let mut tag_map: HashMap<String, Vec<String>> = HashMap::new();

    for (rel_path, meta, _content) in &pages {
        for tag in &meta.tags {
            tag_map
                .entry(tag.clone())
                .or_default()
                .push(rel_path.clone());
        }
    }

    let mut result: Vec<TagUsage> = tag_map
        .into_iter()
        .map(|(tag, pages)| TagUsage {
            count: pages.len(),
            tag,
            pages,
        })
        .collect();

    result.sort_by(|a, b| b.count.cmp(&a.count));
    Ok(result)
}

/// Apply a [`TagOperation`] to every page in the vault, returning how many
/// pages were changed.
pub fn bulk_tag_operation(vault_dir: &Path, op: TagOperation) -> Result<BulkTagResult, PageError> {
    let pages = collect_all_pages(vault_dir)?;
    let mut affected = 0;

    match op {
        TagOperation::Rename { from, to } => {
            for (rel_path, meta, _content) in &pages {
                if meta.tags.contains(&from) {
                    let mut new_tags: Vec<String> = meta
                        .tags
                        .iter()
                        .map(|t| if t == &from { to.clone() } else { t.clone() })
                        .collect();
                    // Deduplicate
                    new_tags.sort();
                    new_tags.dedup();
                    crud::update_tags(vault_dir, rel_path, new_tags)?;
                    affected += 1;
                }
            }
        }
        TagOperation::Delete { tag } => {
            for (rel_path, meta, _content) in &pages {
                if meta.tags.contains(&tag) {
                    let new_tags: Vec<String> =
                        meta.tags.iter().filter(|t| *t != &tag).cloned().collect();
                    crud::update_tags(vault_dir, rel_path, new_tags)?;
                    affected += 1;
                }
            }
        }
        TagOperation::Merge { from, into } => {
            for (rel_path, meta, _content) in &pages {
                if meta.tags.contains(&from) {
                    let mut new_tags: Vec<String> = meta
                        .tags
                        .iter()
                        .map(|t| if t == &from { into.clone() } else { t.clone() })
                        .collect();
                    new_tags.sort();
                    new_tags.dedup();
                    crud::update_tags(vault_dir, rel_path, new_tags)?;
                    affected += 1;
                }
            }
        }
    }

    Ok(BulkTagResult {
        affected_pages: affected,
    })
}
