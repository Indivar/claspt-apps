// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Tauri IPC command handlers for internal / agent-facing vault state and settings.
//!
//! These `#[tauri::command]` functions are invoked from the React frontend over Tauri's
//! IPC bridge. They read and write the JSON-backed side stores kept under the vault's
//! `.securenotes/` directory — share audit log, credential usage journal, device registry,
//! security alerts, password-health history, extension preferences, secret templates,
//! automation rules, import history, and vault statistics — plus two orchestration
//! commands (`run_security_scan` and `post_unlock_init`).
//!
//! Every command resolves the open vault directory via [`get_vault_dir`]; if no vault is
//! open the returned `Result::Err` is the string `"Vault not open"`, which surfaces to the
//! frontend. Store-mutating commands map their underlying I/O errors to strings as well.

use tauri::State;

use super::crypto::VaultState;
#[cfg(feature = "pro")]
use crate::internal::share_log;
use crate::internal::{
    automation, device_registry, extension_prefs, import_history, security_alerts, templates,
    usage_journal, vault_stats,
};
use crate::pages::crud;

/// Resolve the open vault directory from managed state, or `Err("Vault not open")`.
fn get_vault_dir(state: &State<VaultState>) -> Result<std::path::PathBuf, String> {
    state
        .vault_path
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "Vault not open".to_string())
}

/// The master key, which the sealed journals are read and written under.
fn get_master_key(state: &State<VaultState>) -> Result<zeroize::Zeroizing<Vec<u8>>, String> {
    state.master_key().ok_or_else(|| "Vault locked".to_string())
}

// ── Share Audit Log ──────────────────────────────

/// Return the full share audit log (records of every share created from this vault).
#[cfg(feature = "pro")]
#[tauri::command]
pub fn get_share_log(state: State<VaultState>) -> Result<Vec<share_log::ShareLogEntry>, String> {
    let vd = get_vault_dir(&state)?;
    let key = get_master_key(&state)?;
    Ok(share_log::get_share_log(&vd, &key))
}

/// Append a new entry to the share audit log. Errors surface as stringified I/O errors.
#[cfg(feature = "pro")]
#[tauri::command]
pub fn log_share(state: State<VaultState>, entry: share_log::ShareLogEntry) -> Result<(), String> {
    let vd = get_vault_dir(&state)?;
    let key = get_master_key(&state)?;
    share_log::log_share(&vd, &key, &entry).map_err(|e| e.to_string())
}

/// Mark a logged share (by `share_id`) as having been accessed by its recipient.
#[cfg(feature = "pro")]
#[tauri::command]
pub fn mark_share_accessed(state: State<VaultState>, share_id: String) -> Result<(), String> {
    let vd = get_vault_dir(&state)?;
    let key = get_master_key(&state)?;
    share_log::mark_accessed(&vd, &key, &share_id).map_err(|e| e.to_string())
}

/// Mark a logged share (by `share_id`) as revoked.
#[cfg(feature = "pro")]
#[tauri::command]
pub fn mark_share_revoked(state: State<VaultState>, share_id: String) -> Result<(), String> {
    let vd = get_vault_dir(&state)?;
    let key = get_master_key(&state)?;
    share_log::mark_revoked(&vd, &key, &share_id).map_err(|e| e.to_string())
}

// ── Credential Usage Journal ─────────────────────

/// Record that a credential was used (e.g. copied/autofilled) in the usage journal.
#[tauri::command]
pub fn log_credential_usage(
    state: State<VaultState>,
    entry: usage_journal::UsageEntry,
) -> Result<(), String> {
    let vd = get_vault_dir(&state)?;
    let key = get_master_key(&state)?;
    usage_journal::log_usage(&vd, &key, &entry).map_err(|e| e.to_string())
}

/// Return the full credential usage journal.
#[tauri::command]
pub fn get_usage_journal(
    state: State<VaultState>,
) -> Result<Vec<usage_journal::UsageEntry>, String> {
    let vd = get_vault_dir(&state)?;
    let key = get_master_key(&state)?;
    Ok(usage_journal::get_usage_journal(&vd, &key))
}

/// Return the `limit` most recently used credentials from the usage journal.
#[tauri::command]
pub fn get_recently_used(
    state: State<VaultState>,
    limit: usize,
) -> Result<Vec<usage_journal::UsageEntry>, String> {
    let vd = get_vault_dir(&state)?;
    let key = get_master_key(&state)?;
    Ok(usage_journal::get_recently_used(&vd, &key, limit))
}

/// Find credentials not used within the last `days` days.
/// Each tuple is `(page_path, label, last_used)`.
#[tauri::command]
pub fn find_stale_credentials(
    state: State<VaultState>,
    days: i64,
) -> Result<Vec<(String, String, String)>, String> {
    let vd = get_vault_dir(&state)?;
    let key = get_master_key(&state)?;
    Ok(usage_journal::find_stale_credentials(&vd, &key, days))
}

// ── Device Registry ──────────────────────────────

/// Return the devices known to this vault (locally tracked registry, distinct from the
/// Pro sync device list).
#[tauri::command]
pub fn get_devices(state: State<VaultState>) -> Result<Vec<device_registry::DeviceEntry>, String> {
    let vd = get_vault_dir(&state)?;
    Ok(device_registry::get_devices(&vd))
}

/// Register (or update) a device in the local registry by `device_id`.
#[tauri::command]
pub fn register_device(
    state: State<VaultState>,
    device_id: String,
    device_name: String,
    os: String,
    device_type: String,
) -> Result<(), String> {
    let vd = get_vault_dir(&state)?;
    device_registry::register_device(&vd, &device_id, &device_name, &os, &device_type)
        .map_err(|e| e.to_string())
}

/// Remove a device from the local registry by `device_id`.
#[tauri::command]
pub fn remove_device(state: State<VaultState>, device_id: String) -> Result<(), String> {
    let vd = get_vault_dir(&state)?;
    device_registry::remove_device(&vd, &device_id).map_err(|e| e.to_string())
}

// ── Security Alerts ──────────────────────────────

/// Return only the active (non-dismissed, non-resolved) security alerts.
#[tauri::command]
pub fn get_security_alerts(
    state: State<VaultState>,
) -> Result<Vec<security_alerts::SecurityAlert>, String> {
    let vd = get_vault_dir(&state)?;
    let key = get_master_key(&state)?;
    Ok(security_alerts::get_active_alerts(&vd, &key))
}

/// Return all security alerts, including dismissed and resolved ones.
#[tauri::command]
pub fn get_all_security_alerts(
    state: State<VaultState>,
) -> Result<Vec<security_alerts::SecurityAlert>, String> {
    let vd = get_vault_dir(&state)?;
    let key = get_master_key(&state)?;
    Ok(security_alerts::get_alerts(&vd, &key))
}

/// Persist a new security alert.
#[tauri::command]
pub fn add_security_alert(
    state: State<VaultState>,
    alert: security_alerts::SecurityAlert,
) -> Result<(), String> {
    let vd = get_vault_dir(&state)?;
    let key = get_master_key(&state)?;
    security_alerts::add_alert(&vd, &key, &alert).map_err(|e| e.to_string())
}

/// Dismiss a security alert by `alert_id` (hides it but keeps it on record).
#[tauri::command]
pub fn dismiss_security_alert(state: State<VaultState>, alert_id: String) -> Result<(), String> {
    let vd = get_vault_dir(&state)?;
    let key = get_master_key(&state)?;
    security_alerts::dismiss_alert(&vd, &key, &alert_id).map_err(|e| e.to_string())
}

/// Mark a security alert (by `alert_id`) as resolved.
#[tauri::command]
pub fn resolve_security_alert(state: State<VaultState>, alert_id: String) -> Result<(), String> {
    let vd = get_vault_dir(&state)?;
    let key = get_master_key(&state)?;
    security_alerts::resolve_alert(&vd, &key, &alert_id).map_err(|e| e.to_string())
}

// ── Password Health ──────────────────────────────

/// Persist a password-health snapshot to the internal store for trend history.
#[tauri::command]
pub fn save_health_snapshot(
    state: State<VaultState>,
    snapshot: security_alerts::PasswordHealthSnapshot,
) -> Result<(), String> {
    let vd = get_vault_dir(&state)?;
    let key = get_master_key(&state)?;
    security_alerts::save_health_snapshot(&vd, &key, &snapshot).map_err(|e| e.to_string())
}

/// Return the stored history of password-health snapshots.
#[tauri::command]
pub fn get_health_history(
    state: State<VaultState>,
) -> Result<Vec<security_alerts::PasswordHealthSnapshot>, String> {
    let vd = get_vault_dir(&state)?;
    let key = get_master_key(&state)?;
    Ok(security_alerts::get_health_history(&vd, &key))
}

/// Return the most recent password-health snapshot, if any.
#[tauri::command]
pub fn get_latest_health(
    state: State<VaultState>,
) -> Result<Option<security_alerts::PasswordHealthSnapshot>, String> {
    let vd = get_vault_dir(&state)?;
    let key = get_master_key(&state)?;
    Ok(security_alerts::get_latest_health(&vd, &key))
}

// ── Extension Preferences ────────────────────────

/// Get the browser-extension preferences stored for this vault.
#[tauri::command]
pub fn get_extension_prefs(
    state: State<VaultState>,
) -> Result<extension_prefs::ExtensionPrefs, String> {
    let vd = get_vault_dir(&state)?;
    let key = get_master_key(&state)?;
    Ok(extension_prefs::get_prefs(&vd, &key))
}

/// Persist the browser-extension preferences for this vault.
#[tauri::command]
pub fn save_extension_prefs(
    state: State<VaultState>,
    prefs: extension_prefs::ExtensionPrefs,
) -> Result<(), String> {
    let vd = get_vault_dir(&state)?;
    let key = get_master_key(&state)?;
    extension_prefs::save_prefs(&vd, &key, &prefs).map_err(|e| e.to_string())
}

// ── Templates ────────────────────────────────────

/// The owner's saved secret templates. The built-in ones live in the shared
/// list the desktop picker and the extension both read; keeping a second copy
/// here is how the two drifted apart.
#[tauri::command]
pub fn get_templates(state: State<VaultState>) -> Result<Vec<templates::SecretTemplate>, String> {
    let vd = get_vault_dir(&state)?;
    let key = get_master_key(&state)?;
    Ok(templates::get_templates(&vd, &key))
}

/// Create or update a user-defined secret template.
#[tauri::command]
pub fn save_template(
    state: State<VaultState>,
    template: templates::SecretTemplate,
) -> Result<(), String> {
    let vd = get_vault_dir(&state)?;
    let key = get_master_key(&state)?;
    templates::save_template(&vd, &key, &template).map_err(|e| e.to_string())
}

/// Delete a user-defined secret template by id.
#[tauri::command]
pub fn delete_template(state: State<VaultState>, template_id: String) -> Result<(), String> {
    let vd = get_vault_dir(&state)?;
    let key = get_master_key(&state)?;
    templates::delete_template(&vd, &key, &template_id).map_err(|e| e.to_string())
}

// ── Automation Rules ─────────────────────────────

/// List the configured automation rules for this vault.
#[tauri::command]
pub fn get_automation_rules(
    state: State<VaultState>,
) -> Result<Vec<automation::AutomationRule>, String> {
    let vd = get_vault_dir(&state)?;
    Ok(automation::get_rules(&vd))
}

/// Create or update an automation rule.
#[tauri::command]
pub fn save_automation_rule(
    state: State<VaultState>,
    rule: automation::AutomationRule,
) -> Result<(), String> {
    let vd = get_vault_dir(&state)?;
    automation::save_rule(&vd, &rule).map_err(|e| e.to_string())
}

/// Delete an automation rule by id.
#[tauri::command]
pub fn delete_automation_rule(state: State<VaultState>, rule_id: String) -> Result<(), String> {
    let vd = get_vault_dir(&state)?;
    automation::delete_rule(&vd, &rule_id).map_err(|e| e.to_string())
}

/// Enable/disable an automation rule; returns the new enabled state.
#[tauri::command]
pub fn toggle_automation_rule(state: State<VaultState>, rule_id: String) -> Result<bool, String> {
    let vd = get_vault_dir(&state)?;
    automation::toggle_rule(&vd, &rule_id).map_err(|e| e.to_string())
}

// ── Import History ───────────────────────────────

/// Return the log of past import operations for this vault.
#[tauri::command]
pub fn get_import_history(
    state: State<VaultState>,
) -> Result<Vec<import_history::ImportRecord>, String> {
    let vd = get_vault_dir(&state)?;
    Ok(import_history::get_import_history(&vd))
}

/// Append a record of an import operation to the import history.
#[tauri::command]
pub fn log_import(
    state: State<VaultState>,
    record: import_history::ImportRecord,
) -> Result<(), String> {
    let vd = get_vault_dir(&state)?;
    import_history::log_import(&vd, &record).map_err(|e| e.to_string())
}

// ── Vault Stats ──────────────────────────────────

/// Return the stored history of vault-statistics snapshots (for trend charts).
#[tauri::command]
pub fn get_vault_stats(
    state: State<VaultState>,
) -> Result<Vec<vault_stats::StatsSnapshot>, String> {
    let vd = get_vault_dir(&state)?;
    Ok(vault_stats::get_stats(&vd))
}

/// Persist a vault-statistics snapshot to the internal store.
#[tauri::command]
pub fn save_vault_stats_snapshot(
    state: State<VaultState>,
    snapshot: vault_stats::StatsSnapshot,
) -> Result<(), String> {
    let vd = get_vault_dir(&state)?;
    vault_stats::save_snapshot(&vd, &snapshot).map_err(|e| e.to_string())
}

// ── Security Scan ───────────────────────────────

/// Run a security scan — checks password health and generates alerts for weak/reused passwords.
/// Returns the number of new alerts created.
#[tauri::command]
pub fn run_security_scan(state: State<VaultState>) -> Result<u32, String> {
    let vd = get_vault_dir(&state)?;
    let key = get_master_key(&state)?;

    let report = crate::utilities::health::password_health(&vd, &key).map_err(|e| e.to_string())?;

    // Clear old non-dismissed alerts of these types to avoid duplicates
    let existing = security_alerts::get_alerts(&vd, &key);
    let auto_types = ["weak_password", "reused_password"];
    for alert in &existing {
        if auto_types.contains(&alert.alert_type.as_str()) && !alert.dismissed {
            let _ = security_alerts::resolve_alert(&vd, &key, &alert.id);
        }
    }

    let mut count = 0u32;
    for entry in &report.entries {
        if entry.score <= 1 {
            let alert = security_alerts::SecurityAlert::new(
                "weak_password",
                if entry.score == 0 { "critical" } else { "high" },
                &format!("Weak password: {}", entry.label),
                &format!(
                    "Password strength is {} (score {}/4). Estimated crack time: {}. Consider replacing with a stronger password.",
                    entry.label_text, entry.score, entry.crack_time
                ),
            ).for_credential(&entry.page_path, &entry.label);
            let _ = security_alerts::add_alert(&vd, &key, &alert);
            count += 1;
        }
        if entry.reused {
            let alert = security_alerts::SecurityAlert::new(
                "reused_password",
                "high",
                &format!("Reused password: {}", entry.label),
                "This password is used in multiple credentials. If one account is compromised, all accounts sharing this password are at risk.",
            ).for_credential(&entry.page_path, &entry.label);
            let _ = security_alerts::add_alert(&vd, &key, &alert);
            count += 1;
        }
    }

    // Save a health snapshot
    let snapshot = security_alerts::PasswordHealthSnapshot {
        timestamp: chrono::Utc::now().to_rfc3339(),
        score: if report.summary.total == 0 {
            100
        } else {
            let weak: u32 = report.entries.iter().filter(|e| e.score <= 1).count() as u32;
            let reused: u32 = report.summary.reused_count as u32;
            let total = report.summary.total as u32;
            100u32.saturating_sub((weak + reused) * 100 / total.max(1))
        },
        total_credentials: report.summary.total as u32,
        weak_count: report.entries.iter().filter(|e| e.score <= 1).count() as u32,
        reused_count: report.summary.reused_count as u32,
        old_count: 0,
        compromised_count: 0,
        weak_credentials: report
            .entries
            .iter()
            .filter(|e| e.score <= 1)
            .map(|e| e.page_path.clone())
            .collect(),
        reused_credentials: report
            .entries
            .iter()
            .filter(|e| e.reused)
            .map(|e| e.page_path.clone())
            .collect(),
        compromised_credentials: vec![],
    };
    let _ = security_alerts::save_health_snapshot(&vd, &key, &snapshot);

    Ok(count)
}

// ── Post-Unlock Initialization ──────────────────

/// Auto-register this device and capture a vault stats snapshot.
/// Called once after each vault unlock.
#[tauri::command]
pub fn post_unlock_init(
    app: tauri::AppHandle,
    state: State<VaultState>,
    search_state: State<super::search::SearchState>,
) -> Result<(), String> {
    let vd = get_vault_dir(&state)?;

    // Ensure the AI data folders exist so they're visible by default: the MCP
    // server stores secrets under `ai/<service>` and memory under
    // `ai/memory/<namespace>`. Creating them proactively (rather than lazily on
    // first agent write) lets users see and audit the AI area up front.
    let ai_memory = vd.join("ai").join("memory");
    let mut structure_changed = !ai_memory.exists();
    let _ = std::fs::create_dir_all(&ai_memory);

    // One-time migration: relocate legacy hidden `.agent/` memory into the
    // visible, searchable `ai/memory/` tree, then index the moved pages so they
    // are immediately searchable. Idempotent and a no-op once migrated.
    match crate::pages::agent_memory::migrate_legacy_memory(&vd) {
        Ok(moved) if !moved.is_empty() => {
            log::info!("Migrated {} memory page(s) to ai/memory/", moved.len());
            structure_changed = true;
            let pages: Vec<_> = moved
                .iter()
                .filter_map(|p| crud::read_page(&vd, p).ok())
                .collect();
            super::search::index_pages_batch_if_active(&pages, &search_state);
        }
        Ok(_) => {}
        Err(e) => log::warn!("Legacy memory migration skipped: {e}"),
    }

    // Refresh the sidebar if we created or migrated the AI folders, so they
    // appear immediately instead of only after the next folder reload.
    if structure_changed {
        use tauri::Emitter;
        let _ = app.emit("pages-changed", ());
    }

    // Register current device
    let device_id = format!("desktop-{:x}", {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        vd.hash(&mut h);
        h.finish()
    });
    let device_name = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| {
            // Fallback: read /etc/hostname or use "Desktop"
            std::fs::read_to_string("/etc/hostname")
                .map(|s| s.trim().to_string())
                .unwrap_or_else(|_| "Desktop".to_string())
        });
    let os = if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    };
    let _ = device_registry::register_device(&vd, &device_id, &device_name, os, "desktop");

    // Capture vault stats snapshot (at most once per day)
    let latest = vault_stats::get_latest_stats(&vd);
    let should_capture = match &latest {
        Some(snap) => snap
            .timestamp
            .parse::<chrono::DateTime<chrono::Utc>>()
            .ok()
            .map(|dt| chrono::Utc::now() - dt > chrono::Duration::hours(20))
            .unwrap_or(true),
        None => true,
    };

    if should_capture {
        if let Ok(pages) = crud::list_pages(&vd) {
            let secrets = crud::list_secrets(&vd).unwrap_or_default();
            let folders = crud::list_folders(&vd).unwrap_or_default();

            let mut folder_map: std::collections::HashMap<String, u32> =
                std::collections::HashMap::new();
            let mut tag_map: std::collections::HashMap<String, u32> =
                std::collections::HashMap::new();
            for p in &pages {
                *folder_map.entry(p.meta.folder.clone()).or_default() += 1;
                for t in &p.meta.tags {
                    *tag_map.entry(t.to_string()).or_default() += 1;
                }
            }

            let snapshot = vault_stats::capture_snapshot(
                pages.len() as u32,
                secrets.len() as u32,
                folders.len() as u32,
                folder_map
                    .into_iter()
                    .map(|(folder, count)| vault_stats::FolderCount { folder, count })
                    .collect(),
                tag_map
                    .into_iter()
                    .map(|(tag, count)| vault_stats::TagCount { tag, count })
                    .collect(),
                None,
            );
            let _ = vault_stats::save_snapshot(&vd, &snapshot);
        }
    }

    Ok(())
}
