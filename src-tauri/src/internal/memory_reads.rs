// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! How often, and how recently, each memory page has been read.
//!
//! Stale memory is the main failure of every agent memory system: a decision
//! that was reversed, a convention nobody follows, a fact from three months
//! ago. Read counts and last-read times are the cheapest signal that a page
//! still matters. They are kept here, out of band, rather than in the page's
//! frontmatter: writing to the page on every read would bump `updated_at`,
//! which is the ETag, and turn every read into a conflict for a concurrent
//! writer. It would also commit a git change per read.
//!
//! One small JSON map in `.securenotes/internal/`, keyed by page id.

use std::collections::HashMap;
use std::path::Path;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::store::InternalStore;

const FILE: &str = "memory-reads.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadStats {
    pub last_read: DateTime<Utc>,
    pub read_count: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct ReadFile {
    pages: HashMap<String, ReadStats>,
}

/// Count one read of `page_id` now and return the updated stats.
pub fn record_read(vault_dir: &Path, page_id: &str) -> std::io::Result<ReadStats> {
    let mut file = InternalStore::read::<ReadFile>(vault_dir, FILE);
    let entry = file.pages.entry(page_id.to_string()).or_insert(ReadStats {
        last_read: Utc::now(),
        read_count: 0,
    });
    entry.read_count += 1;
    entry.last_read = Utc::now();
    let stats = *entry;
    InternalStore::write(vault_dir, FILE, &file)?;
    Ok(stats)
}

/// Stats for every page that has ever been read through the API.
pub fn all(vault_dir: &Path) -> HashMap<String, ReadStats> {
    InternalStore::read::<ReadFile>(vault_dir, FILE).pages
}

/// Drop the entry for a deleted page.
pub fn forget(vault_dir: &Path, page_id: &str) -> std::io::Result<()> {
    let mut file = InternalStore::read::<ReadFile>(vault_dir, FILE);
    if file.pages.remove(page_id).is_some() {
        InternalStore::write(vault_dir, FILE, &file)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_are_counted_per_page_and_forgotten_on_delete() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        assert!(all(vault).is_empty());
        let first = record_read(vault, "p1").unwrap();
        assert_eq!(first.read_count, 1);
        let second = record_read(vault, "p1").unwrap();
        assert_eq!(second.read_count, 2);
        assert!(second.last_read >= first.last_read);
        record_read(vault, "p2").unwrap();
        let stats = all(vault);
        assert_eq!(stats["p1"].read_count, 2);
        assert_eq!(stats["p2"].read_count, 1);
        forget(vault, "p1").unwrap();
        assert!(!all(vault).contains_key("p1"));
        forget(vault, "never").unwrap();
    }
}
