// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Tauri IPC commands for miscellaneous vault utilities.
//!
//! A grab-bag of helper commands that don't belong to a single feature module — for
//! example password-health analysis over the vault and resetting settings to defaults.
//! These run against the open vault and surface `PageError` to the frontend on failure.
use tauri::{AppHandle, Emitter, State};
use zeroize::Zeroizing;

use super::crypto::VaultState;
use crate::pages::error::PageError;
use crate::utilities;

fn get_vault_dir(state: &State<VaultState>) -> Result<std::path::PathBuf, PageError> {
    state.vault_dir().ok_or(PageError::VaultNotOpen)
}

fn get_master_key(state: &State<VaultState>) -> Result<Zeroizing<Vec<u8>>, PageError> {
    state.master_key().ok_or(PageError::VaultNotOpen)
}

/// Compute summary statistics for the vault (page/secret/folder counts, etc.).
#[tauri::command]
pub fn utility_vault_stats(
    state: State<VaultState>,
) -> Result<utilities::stats::VaultStats, PageError> {
    let vault_dir = get_vault_dir(&state)?;
    utilities::stats::vault_stats(&vault_dir)
}

/// Produce a password-health report (weak/reused/old secrets). Requires the master key to
/// decrypt secret values for analysis.
#[tauri::command]
pub fn utility_password_health(
    state: State<VaultState>,
) -> Result<utilities::health::PasswordHealthReport, PageError> {
    let vault_dir = get_vault_dir(&state)?;
    let key = get_master_key(&state)?;
    utilities::health::password_health(&vault_dir, &key)
}

/// Stored passwords older than the configured rotation limit. Requires the
/// master key to read values for matching against the generator history;
/// the report itself carries no values.
#[tauri::command]
pub fn utility_rotation_due(
    state: State<VaultState>,
) -> Result<utilities::rotation::RotationReport, PageError> {
    let vault_dir = get_vault_dir(&state)?;
    let key = get_master_key(&state)?;
    let days = crate::vault::init::read_config(&vault_dir)
        .map(|c| c.rotation_reminder_days)
        .unwrap_or(0);
    utilities::rotation::rotation_due(&vault_dir, &key, days, chrono::Utc::now())
}

/// Find duplicate/reused secret values across the vault. Requires the master key.
#[tauri::command]
pub fn utility_find_duplicates(
    state: State<VaultState>,
) -> Result<utilities::duplicates::DuplicateReport, PageError> {
    let vault_dir = get_vault_dir(&state)?;
    let key = get_master_key(&state)?;
    utilities::duplicates::find_duplicates(&vault_dir, &key)
}

/// Compute a plan for consolidating credentials from `source_folders` (grouping by domain)
/// without applying it, so the UI can preview the outcome. Requires the master key.
#[tauri::command]
pub fn utility_consolidate_preview(
    state: State<VaultState>,
    source_folders: Vec<String>,
) -> Result<utilities::consolidate::ConsolidatePlan, PageError> {
    let vault_dir = get_vault_dir(&state)?;
    let key = get_master_key(&state)?;
    utilities::consolidate::consolidate_preview(&vault_dir, &key, &source_folders)
}

/// Execute consolidation on a background thread so the UI stays responsive.
/// Emits `consolidate-progress` events for each domain processed.
#[tauri::command]
pub async fn utility_consolidate_execute(
    app: AppHandle,
    state: State<'_, VaultState>,
    plan: utilities::consolidate::ConsolidatePlan,
    target_folder: String,
    source_folders: Vec<String>,
    test_mode: Option<bool>,
    test_limit: Option<usize>,
) -> Result<utilities::consolidate::ConsolidateResult, PageError> {
    let vault_dir = get_vault_dir(&state)?;
    let key = get_master_key(&state)?;

    let is_test = test_mode.unwrap_or(false);
    let limit = test_limit.unwrap_or(0);

    // Run the heavy work on a blocking thread so the UI thread stays free
    let result = tokio::task::spawn_blocking(move || {
        let target = if is_test {
            let _ = utilities::consolidate::cleanup_test_folder(&vault_dir);
            utilities::consolidate::TEST_FOLDER.to_string()
        } else if target_folder.is_empty() {
            utilities::consolidate::CONSOLIDATE_FOLDER.to_string()
        } else {
            target_folder
        };

        let folder_created = utilities::consolidate::ensure_folder(&vault_dir, &target)?;

        let groups_to_process: Vec<_> = if is_test && limit > 0 {
            plan.groups.iter().take(limit).collect()
        } else {
            plan.groups.iter().collect()
        };

        let total_groups = groups_to_process.len();
        let mut pages_created = 0usize;
        let mut pages_merged = 0usize;
        let mut secrets_moved = 0usize;

        for (i, group) in groups_to_process.iter().enumerate() {
            // Emit progress — this is thread-safe in Tauri
            let _ = app.emit(
                "consolidate-progress",
                utilities::consolidate::ConsolidateProgress {
                    current: i + 1,
                    total: total_groups,
                    current_domain: group.domain.clone(),
                    pages_created,
                    secrets_moved,
                },
            );

            let (created, moved) = utilities::consolidate::consolidate_one_group(
                &vault_dir, &key, group, &target, !is_test,
            )?;
            if created > 0 {
                pages_created += created;
            } else if moved > 0 {
                pages_merged += 1;
            }
            secrets_moved += moved;
        }

        // Clean up source folders only in full mode
        let (source_pages_deleted, source_folders_deleted) = if !is_test {
            utilities::consolidate::cleanup_source_folders(&vault_dir, &source_folders, &target)?
        } else {
            (0, vec![])
        };

        let _ = app.emit(
            "consolidate-progress",
            utilities::consolidate::ConsolidateProgress {
                current: total_groups,
                total: total_groups,
                current_domain: "Done".to_string(),
                pages_created,
                secrets_moved,
            },
        );

        Ok::<_, PageError>(utilities::consolidate::ConsolidateResult {
            pages_created,
            pages_merged,
            secrets_moved,
            source_pages_deleted,
            source_folders_deleted,
            folders_created: if folder_created {
                vec![target.clone()]
            } else {
                vec![]
            },
        })
    })
    .await
    .map_err(|e| PageError::Crypto(format!("task join error: {e}")))??;

    Ok(result)
}

/// List every tag with how many pages use it, for tag-management UI.
#[tauri::command]
pub fn utility_list_tags_usage(
    state: State<VaultState>,
) -> Result<Vec<utilities::tags::TagUsage>, PageError> {
    let vault_dir = get_vault_dir(&state)?;
    utilities::tags::list_tags_usage(&vault_dir)
}

/// Apply a bulk tag operation (rename/merge/delete a tag across all pages) described by
/// `op`, returning how many pages were affected.
#[tauri::command]
pub fn utility_bulk_tag_operation(
    state: State<VaultState>,
    op: utilities::tags::TagOperation,
) -> Result<utilities::tags::BulkTagResult, PageError> {
    let vault_dir = get_vault_dir(&state)?;
    utilities::tags::bulk_tag_operation(&vault_dir, op)
}

/// Check the vault's secrets against known breach data and return a report. Requires the
/// master key to access the values being checked.
#[tauri::command]
pub fn utility_breach_check(
    state: State<VaultState>,
) -> Result<utilities::breach::BreachCheckReport, PageError> {
    let vault_dir = get_vault_dir(&state)?;
    let key = get_master_key(&state)?;
    utilities::breach::breach_check(&vault_dir, &key)
}

/// Force-refresh help pages regardless of current version stamp.
/// Deletes existing help pages and recreates them with current content.
#[tauri::command]
pub fn utility_reset_help_pages(state: State<VaultState>) -> Result<String, PageError> {
    let vault_dir = get_vault_dir(&state)?;

    // Reset the version stamp to force refresh
    if let Ok(mut config) = crate::vault::init::read_config(&vault_dir) {
        config.help_pages_version = Some("0.0.0".to_string());
        let _ = crate::vault::init::write_config(&vault_dir, &config);
    }

    crate::vault::init::refresh_help_pages(&vault_dir);

    let count = crate::vault::help_pages::all().len();
    Ok(format!(
        "Reset {} help pages to version {}",
        count,
        env!("APP_VERSION")
    ))
}

/// Import all `.md` files from a folder into the vault.
#[tauri::command]
pub fn utility_import_folder(
    folder_path: String,
    target_folder: String,
    state: State<VaultState>,
) -> Result<utilities::import_folder::ImportFolderResult, PageError> {
    let vault_dir = get_vault_dir(&state)?;
    let key = get_master_key(&state)?;
    utilities::import_folder::import_folder(&vault_dir, &key, &folder_path, &target_folder)
}
