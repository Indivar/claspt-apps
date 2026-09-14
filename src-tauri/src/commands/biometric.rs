// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Tauri IPC commands for OS biometric unlock (Touch ID on macOS, Windows Hello).
//!
//! Biometric unlock stores the vault's master key (and, since 1.8.2, the sync
//! `group_key`) in the platform keychain/keystore, gated behind an OS biometric
//! prompt. The keychain is the trust boundary: a successful biometric prompt
//! releases the stored key, which is then installed as the active master key so
//! secrets can decrypt again — no password required.
//!
//! Command groups:
//! - availability/status: [`biometric_available`], [`biometric_enrolled`], [`biometric_status`]
//! - enrollment: [`biometric_enroll`] (store key), [`biometric_disable`] (remove it)
//! - unlock: [`biometric_unlock`] (full unlock from a locked vault) and
//!   [`biometric_verify`] (lightweight re-auth while the key is still in memory)
//!
//! Fallible commands return [`BiometricError`], which is serialized to the
//! frontend. Unlock paths share the same [`BruteForceGuard`](crate::vault::auth::BruteForceGuard)
//! as password unlock, so repeated failures incur an escalating delay.

use tauri::{AppHandle, State};
use zeroize::Zeroizing;

use super::crypto::VaultState;
use crate::biometric::error::BiometricError;
use crate::biometric::{keystore, prompt};
use crate::commands::crypto::expand_tilde;
use crate::vault::error::VaultError;
use crate::vault::init;

/// Check if biometric authentication is available on this platform.
#[tauri::command]
pub fn biometric_available() -> bool {
    prompt::is_available()
}

/// Check if a biometric key is enrolled in the platform keychain.
/// Works without the vault being unlocked — just checks keychain presence.
#[tauri::command]
pub fn biometric_enrolled() -> bool {
    keystore::has_stored_key().unwrap_or(false)
}

/// Enroll biometric unlock: authenticate with biometric, then store the
/// current master key in the platform keychain.
///
/// `mode` must be "reauth" or "primary" (defaults to "primary").
#[tauri::command]
pub fn biometric_enroll(
    vault_dir: String,
    mode: Option<String>,
    state: State<VaultState>,
) -> Result<(), BiometricError> {
    // Validate biometric mode against whitelist
    let biometric_mode = mode.unwrap_or_else(|| "primary".to_string());
    if biometric_mode != "reauth" && biometric_mode != "primary" {
        return Err(BiometricError::InvalidMode(biometric_mode));
    }

    // Require biometric proof
    prompt::authenticate("Claspt wants to enable biometric unlock")?;

    // Clone the master key inside a short-lived lock scope, then release
    // before doing slow keychain + filesystem I/O (MED-1).
    let master_key_clone = {
        let guard = state
            .master_key
            .lock()
            .map_err(|_| BiometricError::AuthFailed("lock poisoned".into()))?;
        let key = guard
            .as_ref()
            .ok_or_else(|| BiometricError::AuthFailed("vault is locked".into()))?;
        Zeroizing::new(key.to_vec())
    };
    // Also snapshot the group_key — needed so biometric unlock can restore
    // it. If this is None (shouldn't happen post-unlock) we skip; next
    // password unlock will write it.
    let group_key_clone = state
        .group_key
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|k| Zeroizing::new(k.to_vec())));

    // Store in keychain (lock already released)
    keystore::store_master_key(&master_key_clone)?;
    if let Some(gk) = group_key_clone {
        keystore::store_group_key(&gk)?;
    }

    // Update vault config with the selected biometric mode
    let vault_path = expand_tilde(&vault_dir);
    if let Ok(mut config) = init::read_config(&vault_path) {
        config.biometric_mode = biometric_mode;
        let _ = init::write_config(&vault_path, &config);
    }

    Ok(())
}

/// Atomically check brute-force delay and stamp the attempt, mapped to BiometricError.
fn begin_brute_force_attempt(state: &State<VaultState>) -> Result<(), BiometricError> {
    state.brute_force.begin_attempt().map_err(|e| match e {
        VaultError::BruteForceDelay(secs) => BiometricError::BruteForceDelay(secs),
        other => BiometricError::AuthFailed(other.to_string()),
    })
}

/// Unlock vault using biometric: authenticate, retrieve key from keychain,
/// set it as the active master key.
#[tauri::command]
pub fn biometric_unlock(
    app: AppHandle,
    vault_dir: String,
    state: State<VaultState>,
    search_state: State<super::search::SearchState>,
    git_state: State<super::git::GitState>,
    sync_v2: State<super::sync::SyncV2Managed>,
    inbox_state: State<crate::inbox::InboxState>,
) -> Result<(), BiometricError> {
    // Brute force guard — shared with password unlock (atomic check + stamp)
    begin_brute_force_attempt(&state)?;

    let vault_path = expand_tilde(&vault_dir);

    // Verify vault exists
    init::validate_vault_exists(&vault_path)
        .map_err(|e| BiometricError::AuthFailed(e.to_string()))?;

    // Require biometric proof
    prompt::authenticate("Unlock Claspt vault")?;

    // Retrieve master key from keychain
    let master_key = keystore::retrieve_master_key()?;
    // And the group key — stored next to the master key since 1.8.2. If
    // the entry is missing (biometric enrolled on an older version), sync
    // will fall back to the legacy behaviour until the next password
    // unlock re-writes both entries.
    let group_key = keystore::retrieve_group_key().unwrap_or(None);

    // The OS keychain is the trust boundary for biometric unlock.
    // If the key is stale, the first secret block decryption will fail gracefully.

    // Success — reset brute force counter
    state.brute_force.record_success();

    // Set as active key (master_key is already Zeroizing<Vec<u8>> from keystore)
    *state
        .master_key
        .lock()
        .map_err(|_| BiometricError::AuthFailed("lock poisoned".into()))? = Some(master_key);
    if let Some(gk) = group_key {
        *state
            .group_key
            .lock()
            .map_err(|_| BiometricError::AuthFailed("lock poisoned".into()))? = Some(gk);
    }
    *state
        .vault_path
        .lock()
        .map_err(|_| BiometricError::AuthFailed("lock poisoned".into()))? =
        Some(vault_path.clone());

    // Signal ensure_engine to drop the cached engine on its next call.
    // Same reasoning as unlock_vault — we're a sync Tauri command on the
    // tokio runtime and block_on would deadlock on Windows.
    sync_v2
        .invalidate
        .store(true, std::sync::atomic::Ordering::Release);

    // Initialize search engine
    if let Err(e) = super::search::init_search_engine(&vault_path, &search_state) {
        log::warn!("Failed to initialize search engine: {e}");
    }

    // Initialize git batch committer
    super::git::init_git_state(&vault_path, &git_state);

    // Auto-start local API server if enabled
    if let Ok(cfg) = init::read_config(&vault_path) {
        if cfg.local_api_enabled == Some(true) {
            let has_any_token = cfg.local_api_token.as_ref().is_some_and(|t| !t.is_empty())
                || cfg
                    .local_api_notes_token
                    .as_ref()
                    .is_some_and(|t| !t.is_empty())
                || cfg
                    .local_api_secrets_token
                    .as_ref()
                    .is_some_and(|t| !t.is_empty());
            if has_any_token {
                let port = cfg.local_api_port;
                let handle = app.clone();
                tauri::async_runtime::handle().spawn(async move {
                    if let Err(e) = crate::local_api::server::start_server(port, handle).await {
                        log::error!("Local API auto-start failed: {e}");
                    }
                });
            }
        }
    }

    // Start inbox watcher
    if let Some(mk) = state.master_key() {
        crate::inbox::start_inbox_watcher(
            vault_path,
            mk,
            &inbox_state,
            &search_state,
            &git_state,
            Some(app.clone()),
        );
    }

    Ok(())
}

/// Lightweight biometric verification for UI-lock mode.
///
/// Only prompts the OS biometric dialog and checks brute-force guard.
/// Does NOT retrieve the master key from keychain or re-initialize subsystems,
/// because the vault is already unlocked (master key is in memory).
#[tauri::command]
pub fn biometric_verify(state: State<VaultState>) -> Result<(), BiometricError> {
    begin_brute_force_attempt(&state)?;
    prompt::authenticate("Unlock Claspt vault")?;
    state.brute_force.record_success();
    Ok(())
}

/// Disable biometric unlock: remove stored key from keychain and update config.
/// Uses vault path from state instead of caller-supplied parameter (HIGH-2).
#[tauri::command]
pub fn biometric_disable(state: State<VaultState>) -> Result<(), BiometricError> {
    // Remove both keychain entries (ignore NoCredential — already gone)
    match keystore::delete_master_key() {
        Ok(()) | Err(BiometricError::NoCredential) => {}
        Err(e) => return Err(e),
    }
    // delete_group_key is already idempotent on NoEntry.
    let _ = keystore::delete_group_key();

    // Derive vault path from trusted state
    let vault_path = state
        .vault_path
        .lock()
        .map_err(|_| BiometricError::AuthFailed("lock poisoned".into()))?
        .clone();

    if let Some(ref vp) = vault_path {
        if let Ok(mut config) = init::read_config(vp) {
            config.biometric_mode = "disabled".to_string();
            let _ = init::write_config(vp, &config);
        }
    }

    Ok(())
}

/// Return the current biometric mode from vault config.
/// Uses vault path from state instead of caller-supplied parameter (HIGH-2).
#[tauri::command]
pub fn biometric_status(state: State<VaultState>) -> Result<String, BiometricError> {
    let vault_path = state
        .vault_path
        .lock()
        .map_err(|_| BiometricError::AuthFailed("lock poisoned".into()))?
        .clone();

    let vp = vault_path.ok_or_else(|| BiometricError::AuthFailed("vault is locked".into()))?;

    let config =
        init::read_config(&vp).map_err(|e| BiometricError::KeychainError(e.to_string()))?;
    Ok(config.biometric_mode)
}
