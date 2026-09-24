// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Credential Usage Journal — tracks when credentials are accessed/filled.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::path::Path;

use super::store::InternalStore;

const FILENAME: &str = "usage-journal.json";
const MAX_ENTRIES: usize = 5000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageEntry {
    /// ISO 8601 timestamp
    pub timestamp: String,
    /// Page path containing the credential
    pub page_path: String,
    /// Secret block label
    pub label: String,
    /// Action: "fill", "copy", "reveal", "create", "update", "delete"
    pub action: String,
    /// Source: "extension", "desktop", "api", "mcp"
    pub source: String,
    /// Domain where the fill occurred (for extension fills)
    pub domain: Option<String>,
    /// Device identifier
    pub device_id: Option<String>,
}

impl UsageEntry {
    pub fn new(page_path: &str, label: &str, action: &str, source: &str) -> Self {
        Self {
            timestamp: Utc::now().to_rfc3339(),
            page_path: page_path.to_string(),
            label: label.to_string(),
            action: action.to_string(),
            source: source.to_string(),
            domain: None,
            device_id: None,
        }
    }

    pub fn with_domain(mut self, domain: &str) -> Self {
        self.domain = Some(domain.to_string());
        self
    }

    pub fn with_device(mut self, device_id: &str) -> Self {
        self.device_id = Some(device_id.to_string());
        self
    }
}

/// Record a credential usage event.
pub fn log_usage(vault_dir: &Path, master_key: &[u8], entry: &UsageEntry) -> std::io::Result<()> {
    InternalStore::append_sealed(vault_dir, FILENAME, entry, MAX_ENTRIES, master_key)
}

/// Get all usage entries.
pub fn get_usage_journal(vault_dir: &Path, master_key: &[u8]) -> Vec<UsageEntry> {
    InternalStore::read_sealed(vault_dir, FILENAME, master_key)
}

/// Get usage entries for a specific credential.
pub fn get_credential_usage(
    vault_dir: &Path,
    master_key: &[u8],
    page_path: &str,
    label: &str,
) -> Vec<UsageEntry> {
    get_usage_journal(vault_dir, master_key)
        .into_iter()
        .filter(|e| e.page_path == page_path && e.label == label)
        .collect()
}

/// Get recently used credentials (unique, most recent first).
pub fn get_recently_used(vault_dir: &Path, master_key: &[u8], limit: usize) -> Vec<UsageEntry> {
    let entries = get_usage_journal(vault_dir, master_key);
    let mut seen = std::collections::HashSet::new();
    let mut recent = Vec::new();

    for entry in entries.into_iter().rev() {
        let key = format!("{}:{}", entry.page_path, entry.label);
        if seen.insert(key) {
            recent.push(entry);
            if recent.len() >= limit {
                break;
            }
        }
    }
    recent
}

/// Find stale credentials (not used in N days).
pub fn find_stale_credentials(
    vault_dir: &Path,
    master_key: &[u8],
    days: i64,
) -> Vec<(String, String, String)> {
    let entries = get_usage_journal(vault_dir, master_key);
    let cutoff = Utc::now() - chrono::Duration::days(days);
    let mut last_used: std::collections::HashMap<String, String> = std::collections::HashMap::new();

    for entry in &entries {
        let key = format!("{}:{}", entry.page_path, entry.label);
        last_used.insert(key, entry.timestamp.clone());
    }

    last_used
        .into_iter()
        .filter_map(|(key, ts)| {
            if let Ok(dt) = ts.parse::<chrono::DateTime<Utc>>() {
                if dt < cutoff {
                    let parts: Vec<&str> = key.splitn(2, ':').collect();
                    return Some((parts[0].to_string(), parts[1].to_string(), ts));
                }
            }
            None
        })
        .collect()
}
