// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Import History — records every import operation.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::path::Path;

use super::store::InternalStore;

const FILENAME: &str = "import-history.json";
const MAX_ENTRIES: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportRecord {
    /// ISO 8601 timestamp
    pub timestamp: String,
    /// Source: "1password", "bitwarden", "lastpass", "csv", "xml", "keepass", "chrome", "firefox"
    pub source: String,
    /// Original filename (if applicable)
    pub filename: Option<String>,
    /// Number of items imported
    pub items_imported: u32,
    /// Number of pages created
    pub pages_created: u32,
    /// Number of secrets imported
    pub secrets_imported: u32,
    /// Number of duplicates skipped
    pub duplicates_skipped: u32,
    /// Number of items that failed to import
    pub failures: u32,
    /// SHA-256 hash of the import file (to detect re-imports)
    pub file_hash: Option<String>,
    /// Target folder where items were imported
    pub target_folder: String,
}

impl ImportRecord {
    pub fn new(source: &str, target_folder: &str) -> Self {
        Self {
            timestamp: Utc::now().to_rfc3339(),
            source: source.to_string(),
            filename: None,
            items_imported: 0,
            pages_created: 0,
            secrets_imported: 0,
            duplicates_skipped: 0,
            failures: 0,
            file_hash: None,
            target_folder: target_folder.to_string(),
        }
    }
}

/// Record an import operation.
pub fn log_import(vault_dir: &Path, record: &ImportRecord) -> std::io::Result<()> {
    InternalStore::append(vault_dir, FILENAME, record, MAX_ENTRIES)
}

/// Get all import records.
pub fn get_import_history(vault_dir: &Path) -> Vec<ImportRecord> {
    InternalStore::read(vault_dir, FILENAME)
}

/// Check if a file has been imported before (by hash).
pub fn was_imported(vault_dir: &Path, file_hash: &str) -> bool {
    get_import_history(vault_dir)
        .iter()
        .any(|r| r.file_hash.as_deref() == Some(file_hash))
}
