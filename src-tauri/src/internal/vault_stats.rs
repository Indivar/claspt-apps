// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Vault Analytics — usage statistics (local only, no telemetry).

use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::path::Path;

use super::store::InternalStore;

const FILENAME: &str = "vault-stats.json";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct VaultStats {
    pub snapshots: Vec<StatsSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatsSnapshot {
    /// ISO 8601 timestamp
    pub timestamp: String,
    /// Total pages in vault
    pub total_pages: u32,
    /// Total secret blocks across all pages
    pub total_secrets: u32,
    /// Total folders
    pub total_folders: u32,
    /// Pages per folder breakdown
    pub folder_counts: Vec<FolderCount>,
    /// Tag usage counts
    pub tag_counts: Vec<TagCount>,
    /// Average password strength score (0-4)
    pub avg_password_strength: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderCount {
    pub folder: String,
    pub count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TagCount {
    pub tag: String,
    pub count: u32,
}

/// Save a new stats snapshot.
pub fn save_snapshot(vault_dir: &Path, snapshot: &StatsSnapshot) -> std::io::Result<()> {
    let mut stats: VaultStats = InternalStore::read(vault_dir, FILENAME);
    stats.snapshots.push(snapshot.clone());
    // Keep last 365 snapshots (one per day for a year)
    if stats.snapshots.len() > 365 {
        stats.snapshots = stats.snapshots.split_off(stats.snapshots.len() - 365);
    }
    InternalStore::write(vault_dir, FILENAME, &stats)
}

/// Get vault stats history.
pub fn get_stats(vault_dir: &Path) -> Vec<StatsSnapshot> {
    let stats: VaultStats = InternalStore::read(vault_dir, FILENAME);
    stats.snapshots
}

/// Get the latest stats snapshot.
pub fn get_latest_stats(vault_dir: &Path) -> Option<StatsSnapshot> {
    let stats: VaultStats = InternalStore::read(vault_dir, FILENAME);
    stats.snapshots.last().cloned()
}

/// Create a stats snapshot from current vault state.
pub fn capture_snapshot(
    total_pages: u32,
    total_secrets: u32,
    total_folders: u32,
    folder_counts: Vec<FolderCount>,
    tag_counts: Vec<TagCount>,
    avg_strength: Option<f32>,
) -> StatsSnapshot {
    StatsSnapshot {
        timestamp: Utc::now().to_rfc3339(),
        total_pages,
        total_secrets,
        total_folders,
        folder_counts,
        tag_counts,
        avg_password_strength: avg_strength,
    }
}
