// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Security Alerts + Password Health History.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::path::Path;

use super::store::InternalStore;

const ALERTS_FILE: &str = "security-alerts.json";
const HEALTH_FILE: &str = "password-health.json";
const MAX_ALERTS: usize = 500;

// ── Security Alerts ──────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecurityAlert {
    /// Unique alert ID
    pub id: String,
    /// ISO 8601 timestamp
    pub timestamp: String,
    /// Alert type: "breach", "weak_password", "reused_password", "stale_password",
    /// "domain_compromised", "unusual_access", "password_expiry"
    pub alert_type: String,
    /// Severity: "critical", "high", "medium", "low", "info"
    pub severity: String,
    /// Human-readable title
    pub title: String,
    /// Detailed description
    pub description: String,
    /// Affected credential (page path + label), if applicable
    pub page_path: Option<String>,
    pub label: Option<String>,
    /// Whether the user has dismissed this alert
    pub dismissed: bool,
    /// Whether the alert has been resolved (e.g., password changed)
    pub resolved: bool,
}

impl SecurityAlert {
    pub fn new(alert_type: &str, severity: &str, title: &str, description: &str) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            timestamp: Utc::now().to_rfc3339(),
            alert_type: alert_type.to_string(),
            severity: severity.to_string(),
            title: title.to_string(),
            description: description.to_string(),
            page_path: None,
            label: None,
            dismissed: false,
            resolved: false,
        }
    }

    pub fn for_credential(mut self, page_path: &str, label: &str) -> Self {
        self.page_path = Some(page_path.to_string());
        self.label = Some(label.to_string());
        self
    }
}

/// Add a security alert.
pub fn add_alert(
    vault_dir: &Path,
    master_key: &[u8],
    alert: &SecurityAlert,
) -> std::io::Result<()> {
    InternalStore::append_sealed(vault_dir, ALERTS_FILE, alert, MAX_ALERTS, master_key)
}

/// Get all security alerts.
pub fn get_alerts(vault_dir: &Path, master_key: &[u8]) -> Vec<SecurityAlert> {
    InternalStore::read_sealed(vault_dir, ALERTS_FILE, master_key)
}

/// Get active (not dismissed, not resolved) alerts.
pub fn get_active_alerts(vault_dir: &Path, master_key: &[u8]) -> Vec<SecurityAlert> {
    get_alerts(vault_dir, master_key)
        .into_iter()
        .filter(|a| !a.dismissed && !a.resolved)
        .collect()
}

/// Dismiss an alert.
pub fn dismiss_alert(vault_dir: &Path, master_key: &[u8], alert_id: &str) -> std::io::Result<()> {
    let mut alerts: Vec<SecurityAlert> =
        InternalStore::read_sealed(vault_dir, ALERTS_FILE, master_key);
    if let Some(alert) = alerts.iter_mut().find(|a| a.id == alert_id) {
        alert.dismissed = true;
    }
    InternalStore::write_sealed(vault_dir, ALERTS_FILE, &alerts, master_key)
}

/// Mark an alert as resolved.
pub fn resolve_alert(vault_dir: &Path, master_key: &[u8], alert_id: &str) -> std::io::Result<()> {
    let mut alerts: Vec<SecurityAlert> =
        InternalStore::read_sealed(vault_dir, ALERTS_FILE, master_key);
    if let Some(alert) = alerts.iter_mut().find(|a| a.id == alert_id) {
        alert.resolved = true;
    }
    InternalStore::write_sealed(vault_dir, ALERTS_FILE, &alerts, master_key)
}

// ── Password Health History ──────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PasswordHealthSnapshot {
    /// ISO 8601 timestamp
    pub timestamp: String,
    /// Overall health score (0-100)
    pub score: u32,
    /// Total credentials scanned
    pub total_credentials: u32,
    /// Number of weak passwords
    pub weak_count: u32,
    /// Number of reused passwords
    pub reused_count: u32,
    /// Number of old passwords (> 6 months)
    pub old_count: u32,
    /// Number of compromised passwords (from HIBP)
    pub compromised_count: u32,
    /// List of weak credential paths
    pub weak_credentials: Vec<String>,
    /// List of reused credential paths
    pub reused_credentials: Vec<String>,
    /// List of compromised credential paths
    pub compromised_credentials: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PasswordHealthHistory {
    pub snapshots: Vec<PasswordHealthSnapshot>,
}

/// Save a new health scan snapshot.
pub fn save_health_snapshot(
    vault_dir: &Path,
    master_key: &[u8],
    snapshot: &PasswordHealthSnapshot,
) -> std::io::Result<()> {
    let mut history: PasswordHealthHistory =
        InternalStore::read_sealed(vault_dir, HEALTH_FILE, master_key);
    history.snapshots.push(snapshot.clone());
    // Keep last 100 snapshots
    if history.snapshots.len() > 100 {
        history.snapshots = history.snapshots.split_off(history.snapshots.len() - 100);
    }
    InternalStore::write_sealed(vault_dir, HEALTH_FILE, &history, master_key)
}

/// Get password health history.
pub fn get_health_history(vault_dir: &Path, master_key: &[u8]) -> Vec<PasswordHealthSnapshot> {
    let history: PasswordHealthHistory =
        InternalStore::read_sealed(vault_dir, HEALTH_FILE, master_key);
    history.snapshots
}

/// Get the latest health snapshot.
pub fn get_latest_health(vault_dir: &Path, master_key: &[u8]) -> Option<PasswordHealthSnapshot> {
    let history: PasswordHealthHistory =
        InternalStore::read_sealed(vault_dir, HEALTH_FILE, master_key);
    history.snapshots.last().cloned()
}
