// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Extension State Sync — browser extension preferences synced via vault.

use serde::{Deserialize, Serialize};
use std::path::Path;

use super::store::InternalStore;

const FILENAME: &str = "extension-prefs.json";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ExtensionPrefs {
    /// Domains to never prompt save on
    pub excluded_domains: Vec<String>,
    /// Per-domain preferred credential
    pub domain_preferences: Vec<DomainCredentialPref>,
    /// Recently used credentials (synced across browsers)
    pub recently_used: Vec<RecentlyUsedEntry>,
    /// Generator defaults
    pub generator_defaults: Option<GeneratorDefaults>,
    /// Last updated timestamp
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DomainCredentialPref {
    pub domain: String,
    pub preferred_page_path: String,
    pub preferred_label: String,
    /// URL matching mode: "base_domain", "host", "exact", "never"
    pub match_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecentlyUsedEntry {
    pub page_path: String,
    pub label: String,
    pub domain: String,
    pub username: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeneratorDefaults {
    pub length: u32,
    pub uppercase: bool,
    pub lowercase: bool,
    pub digits: bool,
    pub symbols: bool,
    pub exclude_ambiguous: bool,
}

/// Read extension preferences from vault.
pub fn get_prefs(vault_dir: &Path, master_key: &[u8]) -> ExtensionPrefs {
    InternalStore::read_sealed(vault_dir, FILENAME, master_key)
}

/// Save extension preferences to vault.
pub fn save_prefs(
    vault_dir: &Path,
    master_key: &[u8],
    prefs: &ExtensionPrefs,
) -> std::io::Result<()> {
    let mut prefs = prefs.clone();
    prefs.updated_at = Some(chrono::Utc::now().to_rfc3339());
    InternalStore::write_sealed(vault_dir, FILENAME, &prefs, master_key)
}

/// Add a domain to the excluded list.
pub fn add_excluded_domain(
    vault_dir: &Path,
    master_key: &[u8],
    domain: &str,
) -> std::io::Result<()> {
    let mut prefs = get_prefs(vault_dir, master_key);
    if !prefs.excluded_domains.contains(&domain.to_string()) {
        prefs.excluded_domains.push(domain.to_string());
    }
    save_prefs(vault_dir, master_key, &prefs)
}

/// Remove a domain from the excluded list.
pub fn remove_excluded_domain(
    vault_dir: &Path,
    master_key: &[u8],
    domain: &str,
) -> std::io::Result<()> {
    let mut prefs = get_prefs(vault_dir, master_key);
    prefs.excluded_domains.retain(|d| d != domain);
    save_prefs(vault_dir, master_key, &prefs)
}

/// Record a recently used credential.
pub fn record_recent(
    vault_dir: &Path,
    master_key: &[u8],
    entry: RecentlyUsedEntry,
) -> std::io::Result<()> {
    let mut prefs = get_prefs(vault_dir, master_key);

    // Remove existing entry for same credential
    prefs
        .recently_used
        .retain(|r| !(r.page_path == entry.page_path && r.label == entry.label));

    // Add to front
    prefs.recently_used.insert(0, entry);

    // Keep max 50
    prefs.recently_used.truncate(50);

    save_prefs(vault_dir, master_key, &prefs)
}
