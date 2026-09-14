// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Vault configuration schema (`config.json`).
//!
//! Defines [`VaultConfig`], the serde-mapped representation of `.securenotes/config.json`, along
//! with its [`Default`] values and [`VaultConfig::validate`] range checks. Most fields use
//! `#[serde(default)]` (or a named default fn) so older config files missing newer keys still
//! deserialize — this is the primary mechanism for forward/backward compatibility as the schema
//! grows. `config.json` is device-local (git-ignored): it holds local-API tokens, the license
//! key, window state, and the master-key verification hash, none of which should ever sync.
//! Reading and writing this struct to disk lives in the [`super::init`] module.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use super::error::VaultError;

/// Vault configuration stored in `.securenotes/config.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultConfig {
    /// On-disk vault schema version (e.g. `"2.0"`), distinct from the app version.
    pub vault_version: String,
    /// Stable per-vault UUID v4; part of the sync group-key derivation. Optional for
    /// legacy configs created before the field existed.
    #[serde(default)]
    pub vault_id: Option<String>,
    /// UI theme name (e.g. `"dark"`, `"light"`).
    pub theme: String,
    /// Editor font size in pixels; `0` means "use the built-in default" (see `validate`).
    pub editor_font_size: u32,
    /// Editor font family name (must be one of the bundled monospace fonts).
    pub editor_font_family: String,
    /// Debounce before an edited page is auto-saved, in milliseconds.
    pub auto_save_delay_ms: u32,
    /// How long a copied secret stays on the clipboard before auto-clear, in seconds.
    pub clipboard_clear_seconds: u32,
    /// How long a revealed secret stays visible before auto-hiding, in seconds.
    pub secret_auto_hide_seconds: u32,
    /// Inactivity timeout before the UI auto-locks, in minutes; `0` disables auto-lock.
    pub auto_lock_minutes: u32,
    /// Biometric unlock policy: `"disabled"`, `"reauth"`, or `"primary"`.
    pub biometric_mode: String,
    /// Sync backend selector: `""` (off), `"local_git"`, `"hosted"`, or `"gdrive"`.
    pub sync_backend: String,
    /// Remote URL for the chosen sync backend, when applicable.
    pub sync_remote_url: Option<String>,
    /// Background sync polling interval, in seconds.
    pub sync_interval_seconds: u32,
    /// Pro license key, if the vault has been licensed.
    pub license_key: Option<String>,
    /// Page id to reopen on next launch, for session restore.
    pub last_opened_page_id: Option<String>,
    #[serde(default = "default_encrypted_page_display")]
    pub encrypted_page_display: String,
    #[serde(default = "default_ui_scale")]
    pub ui_scale: f64,
    #[serde(default)]
    pub markdown_extensions: Option<HashMap<String, bool>>,
    #[serde(default)]
    pub local_api_enabled: Option<bool>,
    #[serde(default = "default_local_api_port")]
    pub local_api_port: u16,
    /// Serve an SSH agent from the vault (keys on pages tagged `ssh-key`).
    #[serde(default)]
    pub ssh_agent_enabled: Option<bool>,
    /// Pre-3.3.7 shared token slots. Read once on unlock by
    /// `local_api::clients::migrate_from_slots`, which turns them into hashed
    /// client records and clears them. Never written with a value again.
    #[serde(default)]
    pub local_api_token: Option<String>,
    #[serde(default)]
    pub local_api_notes_token: Option<String>,
    #[serde(default)]
    pub local_api_secrets_token: Option<String>,
    /// Secret access mode: "auto" (default) or "approve" (require UI approval).
    #[serde(default)]
    pub secret_access_mode: Option<String>,
    /// How many calendar months of the local API access log to keep. Older
    /// month files are deleted when a new month begins. The owner chose a
    /// user-adjustable value over a fixed one; 1 to 120.
    #[serde(default = "default_access_log_retention_months")]
    pub access_log_retention_months: u32,
    /// Secret reads one client may make per minute before being told to wait.
    /// A brake on an agent in a loop; adjustable in both directions, 1 to 600.
    #[serde(default = "default_secret_read_rate_limit_per_minute")]
    pub secret_read_rate_limit_per_minute: u32,
    /// Remind the owner to rotate a stored password older than this many
    /// days (age from the generator history when the value came from it,
    /// else from the page's last save). 0 turns reminders off.
    #[serde(default = "default_rotation_reminder_days")]
    pub rotation_reminder_days: u32,
    /// Default retention, in days, for agent memory pages of each kind that
    /// carry no TTL of their own. 0 keeps forever. Episodic entries (session
    /// logs) are the ones worth letting go; semantic and procedural memory is
    /// the point of the vault, so all three default to keeping everything.
    #[serde(default)]
    pub memory_episodic_retention_days: u32,
    #[serde(default)]
    pub memory_semantic_retention_days: u32,
    #[serde(default)]
    pub memory_procedural_retention_days: u32,
    /// Embedding model a local Ollama serves, used to re-rank memory search
    /// results by meaning. Empty disables re-ranking; full text still works.
    #[serde(default = "default_memory_rerank_model")]
    pub memory_rerank_model: String,
    /// Where Ollama listens. Loopback by default; nothing about a search
    /// leaves the machine unless the user points this elsewhere.
    #[serde(default = "default_ollama_url")]
    pub ollama_url: String,
    /// Minutes before the master key is zeroed from memory (hard lock).
    ///
    /// - `0` (default) = tie the hard lock to `auto_lock_minutes`, so a locked
    ///   vault stops decrypting secrets rather than keeping the key resident
    ///   indefinitely. The effective timeout is resolved in `unlock_vault`.
    /// - A non-zero value sets an explicit hard-lock timeout; validation requires
    ///   it to be `>= auto_lock_minutes` (never zero the key before the UI locks).
    /// - When key-locked, API/MCP can still read pages but cannot decrypt secrets.
    /// - The UI lock (`auto_lock_minutes`) hides the interface but keeps the key.
    #[serde(default)]
    pub key_lock_minutes: u32,
    #[serde(default)]
    pub inbox_enabled: Option<bool>,
    #[serde(default = "default_inbox_folder")]
    pub inbox_default_folder: String,
    /// Tracks the app version when help pages were last written.
    #[serde(default)]
    pub help_pages_version: Option<String>,
    /// Whether the app should poll the share server for incoming shares and updates.
    #[serde(default)]
    pub server_enabled: bool,
    /// SHA-256 verification hash of the master key (hex), for recovery key validation.
    #[serde(default)]
    pub master_key_verify: Option<String>,
    /// Tracks which tour version the user has completed. None = never seen.
    #[serde(default)]
    pub tour_version_seen: Option<u32>,
    /// Which version of the first-run setup walkthrough this vault has seen.
    ///
    /// `None` means it has not run. Stored per VAULT rather than per install, so
    /// creating a second vault runs it again — a vault for work may want to be
    /// set up differently from a personal one, and the answers it collects are
    /// about the vault, not the machine.
    #[serde(default)]
    pub setup_version_seen: Option<u32>,
    /// Email captured during account link / restore. Shown in Settings > Account.
    #[serde(default)]
    pub user_email: Option<String>,
    /// License tier echoed back from the server during account link
    /// ("pro", "pro_plus", etc). Purely informational for the UI.
    #[serde(default)]
    pub user_tier: Option<String>,
    /// Saved window state for restore on next launch.
    #[serde(default)]
    pub window_maximized: Option<bool>,
    #[serde(default)]
    pub window_width: Option<u32>,
    #[serde(default)]
    pub window_height: Option<u32>,
    #[serde(default)]
    pub window_x: Option<i32>,
    #[serde(default)]
    pub window_y: Option<i32>,
}

fn default_encrypted_page_display() -> String {
    "lock_overlay".to_string()
}

fn default_ui_scale() -> f64 {
    1.0
}

fn default_local_api_port() -> u16 {
    9315
}

fn default_memory_rerank_model() -> String {
    "nomic-embed-text".to_string()
}

fn default_ollama_url() -> String {
    "http://127.0.0.1:11434".to_string()
}

fn default_secret_read_rate_limit_per_minute() -> u32 {
    15
}

fn default_rotation_reminder_days() -> u32 {
    180
}

fn default_access_log_retention_months() -> u32 {
    crate::internal::access_log::DEFAULT_RETENTION_MONTHS
}

fn default_inbox_folder() -> String {
    "inbox".to_string()
}

impl VaultConfig {
    /// Validate config values are within acceptable ranges.
    pub fn validate(&self) -> Result<(), VaultError> {
        for (name, days) in [
            (
                "memory_episodic_retention_days",
                self.memory_episodic_retention_days,
            ),
            (
                "memory_semantic_retention_days",
                self.memory_semantic_retention_days,
            ),
            (
                "memory_procedural_retention_days",
                self.memory_procedural_retention_days,
            ),
        ] {
            if days > 3650 {
                return Err(VaultError::InvalidConfig(format!(
                    "{name} must be 0 (keep) or at most 3650, got {days}"
                )));
            }
        }
        if !(1..=600).contains(&self.secret_read_rate_limit_per_minute) {
            return Err(VaultError::InvalidConfig(format!(
                "secret_read_rate_limit_per_minute must be 1–600, got {}",
                self.secret_read_rate_limit_per_minute
            )));
        }
        if self.rotation_reminder_days > 3650 {
            return Err(VaultError::InvalidConfig(format!(
                "rotation_reminder_days must be 0–3650, got {}",
                self.rotation_reminder_days
            )));
        }
        if !(1..=120).contains(&self.access_log_retention_months) {
            return Err(VaultError::InvalidConfig(format!(
                "access_log_retention_months must be 1–120, got {}",
                self.access_log_retention_months
            )));
        }
        // auto_lock_minutes: 0 means disabled; if set, must be 1–1440
        if self.auto_lock_minutes > 0 && !(1..=1440).contains(&self.auto_lock_minutes) {
            return Err(VaultError::InvalidConfig(format!(
                "auto_lock_minutes must be 0 (disabled) or 1–1440, got {}",
                self.auto_lock_minutes
            )));
        }

        // biometric_mode must be one of the known values
        match self.biometric_mode.as_str() {
            "disabled" | "reauth" | "primary" => {}
            other => {
                return Err(VaultError::InvalidConfig(format!(
                    "biometric_mode must be disabled, reauth, or primary, got '{other}'"
                )));
            }
        }

        // sync_backend must be one of the known values (or empty)
        match self.sync_backend.as_str() {
            "" | "local_git" | "hosted" | "gdrive" => {}
            other => {
                return Err(VaultError::InvalidConfig(format!(
                    "sync_backend must be local_git, hosted, gdrive, or empty, got '{other}'"
                )));
            }
        }

        // editor_font_size: 0 means use default; if set, must be 8–72
        if self.editor_font_size > 0 && !(8..=72).contains(&self.editor_font_size) {
            return Err(VaultError::InvalidConfig(format!(
                "editor_font_size must be 0 (default) or 8–72, got {}",
                self.editor_font_size
            )));
        }

        // ui_scale: must be 0.8–1.4
        if !(0.8..=1.4).contains(&self.ui_scale) {
            return Err(VaultError::InvalidConfig(format!(
                "ui_scale must be 0.8–1.4, got {}",
                self.ui_scale
            )));
        }

        // secret_access_mode: must be "auto" or "approve" (or None)
        if let Some(ref mode) = self.secret_access_mode {
            match mode.as_str() {
                "auto" | "approve" => {}
                other => {
                    return Err(VaultError::InvalidConfig(format!(
                        "secret_access_mode must be auto or approve, got '{other}'"
                    )));
                }
            }
        }

        // key_lock_minutes: 0 means disabled; if set, must be >= auto_lock_minutes
        // (key lock must be longer than UI lock, or disabled)
        if self.key_lock_minutes > 0
            && self.auto_lock_minutes > 0
            && self.key_lock_minutes < self.auto_lock_minutes
        {
            return Err(VaultError::InvalidConfig(format!(
                "key_lock_minutes ({}) must be >= auto_lock_minutes ({})",
                self.key_lock_minutes, self.auto_lock_minutes
            )));
        }

        // local_api_port: must be 1024–65535 (unprivileged ports)
        if self.local_api_port > 0 && !(1024..=65535).contains(&self.local_api_port) {
            return Err(VaultError::InvalidConfig(format!(
                "local_api_port must be 1024–65535, got {}",
                self.local_api_port
            )));
        }

        Ok(())
    }

    /// Return the vault_id, generating a UUID v4 if not yet set.
    #[allow(dead_code)]
    pub fn ensure_vault_id(&mut self) -> String {
        if let Some(ref id) = self.vault_id {
            return id.clone();
        }
        let id = uuid::Uuid::new_v4().to_string();
        self.vault_id = Some(id.clone());
        id
    }
}

impl Default for VaultConfig {
    fn default() -> Self {
        Self {
            access_log_retention_months: default_access_log_retention_months(),
            secret_read_rate_limit_per_minute: default_secret_read_rate_limit_per_minute(),
            rotation_reminder_days: 180,
            memory_episodic_retention_days: 0,
            memory_semantic_retention_days: 0,
            memory_procedural_retention_days: 0,
            memory_rerank_model: default_memory_rerank_model(),
            ollama_url: default_ollama_url(),
            vault_version: "2.0".to_string(),
            vault_id: None,
            theme: "dark".to_string(),
            editor_font_size: 14,
            editor_font_family: "JetBrains Mono".to_string(),
            auto_save_delay_ms: 5000,
            clipboard_clear_seconds: 30,
            secret_auto_hide_seconds: 30,
            auto_lock_minutes: 15,
            biometric_mode: "disabled".to_string(),
            sync_backend: "local_git".to_string(),
            sync_remote_url: None,
            sync_interval_seconds: 60,
            license_key: None,
            last_opened_page_id: None,
            encrypted_page_display: "lock_overlay".to_string(),
            ui_scale: 1.0,
            markdown_extensions: None,
            local_api_enabled: None,
            local_api_port: 9315,
            ssh_agent_enabled: None,
            local_api_token: None,
            local_api_notes_token: None,
            local_api_secrets_token: None,
            secret_access_mode: None,
            // 0 = tie the hard key-lock to auto_lock_minutes (see unlock_vault),
            // so a locked vault zeroes the key instead of holding it forever.
            key_lock_minutes: 0,
            inbox_enabled: None,
            inbox_default_folder: "inbox".to_string(),
            help_pages_version: None,
            server_enabled: false,
            master_key_verify: None,
            tour_version_seen: None,
            setup_version_seen: None,
            user_email: None,
            user_tier: None,
            window_maximized: None,
            window_width: None,
            window_height: None,
            window_x: None,
            window_y: None,
        }
    }
}

#[cfg(test)]
mod tests {
    // Tests build a default config then tweak individual fields to exercise
    // validation — clearer than a full struct literal of every field.
    #![allow(clippy::field_reassign_with_default)]
    use super::*;

    #[test]
    fn default_config_serializes() {
        let config = VaultConfig::default();
        let json = serde_json::to_string_pretty(&config).unwrap();
        assert!(json.contains("\"vault_version\": \"2.0\""));
        assert!(json.contains("\"theme\": \"dark\""));
        assert!(json.contains("\"auto_lock_minutes\": 15"));
    }

    #[test]
    fn config_roundtrip() {
        let config = VaultConfig::default();
        let json = serde_json::to_string(&config).unwrap();
        let parsed: VaultConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.vault_version, config.vault_version);
        assert_eq!(parsed.editor_font_size, config.editor_font_size);
    }

    #[test]
    fn default_config_validates() {
        let config = VaultConfig::default();
        assert!(config.validate().is_ok());
    }

    #[test]
    fn validate_rejects_bad_auto_lock_minutes() {
        let mut config = VaultConfig::default();
        config.auto_lock_minutes = 1441;
        assert!(config.validate().is_err());

        // Zero means disabled — should be valid
        config.auto_lock_minutes = 0;
        assert!(config.validate().is_ok());

        // Boundary values
        config.auto_lock_minutes = 1;
        assert!(config.validate().is_ok());
        config.auto_lock_minutes = 1440;
        assert!(config.validate().is_ok());
    }

    #[test]
    fn validate_rejects_bad_biometric_mode() {
        let mut config = VaultConfig::default();
        config.biometric_mode = "invalid".to_string();
        assert!(config.validate().is_err());

        for mode in &["disabled", "reauth", "primary"] {
            config.biometric_mode = mode.to_string();
            assert!(config.validate().is_ok(), "mode '{mode}' should be valid");
        }
    }

    #[test]
    fn validate_rejects_bad_sync_backend() {
        let mut config = VaultConfig::default();
        config.sync_backend = "dropbox".to_string();
        assert!(config.validate().is_err());

        for backend in &["", "local_git", "hosted", "gdrive"] {
            config.sync_backend = backend.to_string();
            assert!(
                config.validate().is_ok(),
                "backend '{backend}' should be valid"
            );
        }
    }

    #[test]
    fn validate_rejects_bad_ui_scale() {
        let mut config = VaultConfig::default();
        config.ui_scale = 0.5;
        assert!(config.validate().is_err());

        config.ui_scale = 1.5;
        assert!(config.validate().is_err());

        // Boundary values
        config.ui_scale = 0.8;
        assert!(config.validate().is_ok());
        config.ui_scale = 1.4;
        assert!(config.validate().is_ok());
        config.ui_scale = 1.0;
        assert!(config.validate().is_ok());
    }

    #[test]
    fn ensure_vault_id_generates_and_persists() {
        let mut config = VaultConfig::default();
        assert!(config.vault_id.is_none());

        let id1 = config.ensure_vault_id();
        assert!(!id1.is_empty());
        assert!(config.vault_id.is_some());

        // Subsequent calls return the same id
        let id2 = config.ensure_vault_id();
        assert_eq!(id1, id2);
    }

    #[test]
    fn vault_id_serde_default_none() {
        // Config without vault_id should deserialize with None
        let json = r#"{"vault_version":"2.0","theme":"dark","editor_font_size":14,"editor_font_family":"JetBrains Mono","auto_save_delay_ms":2000,"clipboard_clear_seconds":30,"secret_auto_hide_seconds":30,"auto_lock_minutes":15,"biometric_mode":"disabled","sync_backend":"local_git","sync_remote_url":null,"sync_interval_seconds":60,"license_key":null,"last_opened_page_id":null,"encrypted_page_display":"lock_overlay","ui_scale":1.0}"#;
        let config: VaultConfig = serde_json::from_str(json).unwrap();
        assert!(config.vault_id.is_none());
    }

    #[test]
    fn validate_rejects_bad_editor_font_size() {
        let mut config = VaultConfig::default();
        config.editor_font_size = 7;
        assert!(config.validate().is_err());

        config.editor_font_size = 73;
        assert!(config.validate().is_err());

        // Zero means use default — should be valid
        config.editor_font_size = 0;
        assert!(config.validate().is_ok());

        // Boundary values
        config.editor_font_size = 8;
        assert!(config.validate().is_ok());
        config.editor_font_size = 72;
        assert!(config.validate().is_ok());
    }
}
