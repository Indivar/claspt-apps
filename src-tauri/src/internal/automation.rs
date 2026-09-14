// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Automation Rules — user-configurable vault automation.
//!
//! Persists a list of automation rules to `.securenotes/internal/automation-rules.json`.
//! Rules describe declarative actions (auto-tagging, auto-foldering, archiving, password
//! rotation reminders, auto-pinning) that other parts of the app consult and apply. This
//! module only stores and manages the rule definitions; it does not execute them.

use serde::{Deserialize, Serialize};
use std::path::Path;

use super::store::InternalStore;

const FILENAME: &str = "automation-rules.json";

/// Root document persisted to `automation-rules.json` — the full set of configured rules.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AutomationConfig {
    /// All automation rules the user has defined, in creation order.
    pub rules: Vec<AutomationRule>,
}

/// A single automation rule: an identified, named, toggleable action of a given `RuleType`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutomationRule {
    /// Unique rule ID
    pub id: String,
    /// Rule name (user-defined)
    pub name: String,
    /// Whether the rule is active
    pub enabled: bool,
    /// Rule type
    pub rule_type: RuleType,
    /// ISO 8601 timestamp of creation
    pub created_at: String,
}

/// The kind of action a rule performs. Serialized with an internal `"type"` tag so each
/// variant round-trips to JSON as `{ "type": "...", ...fields }`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum RuleType {
    /// Auto-tag new credentials from extension with the domain name
    #[serde(rename = "auto_tag_domain")]
    AutoTagDomain,

    /// Auto-move new credentials to a specific folder
    #[serde(rename = "auto_folder")]
    AutoFolder {
        /// Source: "extension", "import", "any"
        source: String,
        /// Target folder
        target_folder: String,
    },

    /// Auto-archive pages not accessed in N days
    #[serde(rename = "auto_archive")]
    AutoArchive {
        /// Days of inactivity before archiving
        days: u32,
    },

    /// Remind to change password every N days
    #[serde(rename = "password_rotation")]
    PasswordRotation {
        /// Days between reminders
        interval_days: u32,
        /// Which credentials this applies to (empty = all)
        credential_filter: Vec<String>,
    },

    /// Auto-pin credentials used more than N times
    #[serde(rename = "auto_pin")]
    AutoPin {
        /// Minimum fill count to trigger pinning
        min_uses: u32,
    },
}

/// Get automation config.
pub fn get_rules(vault_dir: &Path) -> Vec<AutomationRule> {
    let config: AutomationConfig = InternalStore::read(vault_dir, FILENAME);
    config.rules
}

/// Save a rule, updating the existing entry if one shares `rule.id`, otherwise appending it.
pub fn save_rule(vault_dir: &Path, rule: &AutomationRule) -> std::io::Result<()> {
    let mut config: AutomationConfig = InternalStore::read(vault_dir, FILENAME);

    if let Some(existing) = config.rules.iter_mut().find(|r| r.id == rule.id) {
        *existing = rule.clone();
    } else {
        config.rules.push(rule.clone());
    }

    InternalStore::write(vault_dir, FILENAME, &config)
}

/// Delete a rule.
pub fn delete_rule(vault_dir: &Path, rule_id: &str) -> std::io::Result<()> {
    let mut config: AutomationConfig = InternalStore::read(vault_dir, FILENAME);
    config.rules.retain(|r| r.id != rule_id);
    InternalStore::write(vault_dir, FILENAME, &config)
}

/// Flip a rule's `enabled` flag and persist. Returns the new state, or a `NotFound` error
/// if no rule matches `rule_id`.
pub fn toggle_rule(vault_dir: &Path, rule_id: &str) -> std::io::Result<bool> {
    let mut config: AutomationConfig = InternalStore::read(vault_dir, FILENAME);
    let new_state = if let Some(rule) = config.rules.iter_mut().find(|r| r.id == rule_id) {
        rule.enabled = !rule.enabled;
        rule.enabled
    } else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "Rule not found",
        ));
    };
    InternalStore::write(vault_dir, FILENAME, &config)?;
    Ok(new_state)
}

/// Get only enabled rules of a specific type.
pub fn get_active_rules(vault_dir: &Path) -> Vec<AutomationRule> {
    get_rules(vault_dir)
        .into_iter()
        .filter(|r| r.enabled)
        .collect()
}
