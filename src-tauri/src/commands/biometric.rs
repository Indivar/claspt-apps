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

use std::path::Path;

use tauri::{AppHandle, State};
use zeroize::Zeroizing;

use super::crypto::VaultState;
use crate::biometric::error::BiometricError;
use crate::biometric::{keystore, prompt};
use crate::commands::crypto::expand_tilde;
use crate::vault::error::VaultError;
use crate::vault::init;

/// The vault's keychain scope, and the hash that proves a key belongs to it.
///
/// A vault created before `vault_id` existed has none, so one is generated and
/// persisted here: without it the keychain entries cannot be bound to a vault,
/// which is the whole point of scoping them.
fn vault_identity(vault_path: &Path) -> Result<(String, Option<String>), BiometricError> {
    let mut config =
        init::read_config(vault_path).map_err(|e| BiometricError::AuthFailed(e.to_string()))?;
    let had_id = config.vault_id.is_some();
    let vault_id = config.ensure_vault_id();
    if !had_id {
        let _ = init::write_config(vault_path, &config);
    }
    Ok((vault_id, config.master_key_verify.clone()))
}

/// The `vault_id` this vault's keychain entries are stored under, migrating a
/// pre-3.3.34 unscoped entry first if it is provably this vault's. Also hands
/// back the vault's `master_key_verify` hash, so a caller that is about to
/// install a key from the keychain can prove it belongs here.
fn keychain_scope_and_hash(vault_path: &Path) -> Result<(String, Option<String>), BiometricError> {
    let (vault_id, verify_hash) = vault_identity(vault_path)?;
    match keystore::adopt_legacy_entries(&vault_id, verify_hash.as_deref()) {
        Ok(true) => log::info!("Moved this vault's biometric keys to a vault-scoped entry"),
        Ok(false) => {}
        // Not fatal on its own: the caller's own keychain call reports the
        // real failure, and reporting it twice would be noise.
        Err(e) => log::warn!("Could not check for a legacy biometric entry: {e}"),
    }
    Ok((vault_id, verify_hash))
}

/// The `vault_id` this vault's keychain entries are stored under.
fn keychain_scope(vault_path: &Path) -> Result<String, BiometricError> {
    keychain_scope_and_hash(vault_path).map(|(vault_id, _)| vault_id)
}

/// Whether a key that came out of the keychain is this vault's master key.
///
/// `None` when the vault has no `master_key_verify` yet (a vault made before
/// the hash existed and not yet unlocked with its password on this build);
/// that case is accepted, as it always was, because the hash is backfilled
/// on the next password unlock and refusing would lock out a working setup.
/// A hash that is present and does not match is a stale or foreign key: the
/// keychain entry was written for a vault that has since been recovered
/// with a new key, or belongs to another vault entirely. Installing it would
/// seal every new secret under a key nothing else can open.
fn keychain_key_belongs_to_vault(master_key: &[u8], verify_hash: Option<&str>) -> Option<bool> {
    let expected = verify_hash?;
    let actual = claspt_core::crypto::vault_key::compute_master_key_verify(master_key);
    Some(claspt_core::crypto::compare::constant_time_eq(
        actual.as_bytes(),
        expected.as_bytes(),
    ))
}

/// Check if biometric authentication is available on this platform.
#[tauri::command]
pub fn biometric_available() -> bool {
    prompt::is_available()
}

/// Check if a biometric key is enrolled for this vault.
/// Works without the vault being unlocked: `config.json` is plaintext, so the
/// vault's keychain scope can be resolved before any key is available.
#[tauri::command]
pub fn biometric_enrolled(vault_dir: String) -> bool {
    let vault_path = expand_tilde(&vault_dir);
    let Ok(vault_id) = keychain_scope(&vault_path) else {
        return false;
    };
    keystore::has_stored_key(&vault_id).unwrap_or(false)
}

/// Enroll biometric unlock: authenticate with biometric, then store the
/// current master key in the platform keychain.
///
/// `mode` must be "reauth" or "primary" (defaults to "primary").
#[tauri::command]
pub fn biometric_enroll(
    mode: Option<String>,
    state: State<VaultState>,
) -> Result<(), BiometricError> {
    // Validate biometric mode against whitelist
    let biometric_mode = mode.unwrap_or_else(|| "primary".to_string());
    if biometric_mode != "reauth" && biometric_mode != "primary" {
        return Err(BiometricError::InvalidMode(biometric_mode));
    }

    // The scope comes from the vault that is open, never from the caller. A
    // caller-supplied directory stored the open vault's key under another
    // vault's scope, which that vault's next biometric unlock then installed.
    let vault_path = state
        .vault_path
        .lock()
        .map_err(|_| BiometricError::AuthFailed("lock poisoned".into()))?
        .clone()
        .ok_or_else(|| BiometricError::AuthFailed("no vault is open".into()))?;
    let vault_id = keychain_scope(&vault_path)?;

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
    keystore::store_master_key(&vault_id, &master_key_clone)?;
    if let Some(gk) = group_key_clone {
        keystore::store_group_key(&vault_id, &gk)?;
    }

    // Update vault config with the selected biometric mode
    if let Ok(mut config) = init::read_config(&vault_path) {
        config.biometric_mode = biometric_mode;
        let _ = init::write_config(&vault_path, &config);
    }

    Ok(())
}

/// Atomically check brute-force delay and stamp the attempt, mapped to BiometricError.
///
/// The returned attempt is held by the command for the whole unlock, which is
/// what counts it as in flight.
fn begin_brute_force_attempt<'a>(
    state: &'a State<VaultState>,
) -> Result<crate::vault::auth::Attempt<'a>, BiometricError> {
    state.brute_force.begin_attempt().map_err(|e| match e {
        VaultError::BruteForceDelay(secs) => BiometricError::BruteForceDelay(secs),
        other => BiometricError::AuthFailed(other.to_string()),
    })
}

/// Unlock vault using biometric: authenticate, retrieve key from keychain,
/// set it as the active master key.
///
/// Every failure after the guard is recorded against it, the same as a wrong
/// password: a cancelled or rejected prompt and a keychain that will not
/// release the key are both attempts, and an attacker at the keyboard gets
/// the same escalating delay whichever door they try.
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
    let _attempt = begin_brute_force_attempt(&state)?;

    let result = biometric_unlock_inner(
        app,
        vault_dir,
        &state,
        &search_state,
        &git_state,
        &sync_v2,
        &inbox_state,
    );
    if result.is_err() {
        state.brute_force.record_failure();
    }
    result
}

fn biometric_unlock_inner(
    app: AppHandle,
    vault_dir: String,
    state: &State<VaultState>,
    search_state: &State<super::search::SearchState>,
    git_state: &State<super::git::GitState>,
    sync_v2: &State<super::sync::SyncV2Managed>,
    inbox_state: &State<crate::inbox::InboxState>,
) -> Result<(), BiometricError> {
    let vault_path = expand_tilde(&vault_dir);

    // Verify vault exists
    init::validate_vault_exists(&vault_path)
        .map_err(|e| BiometricError::AuthFailed(e.to_string()))?;

    // Require biometric proof
    prompt::authenticate("Unlock Claspt vault")?;

    // Retrieve master key from keychain, under this vault's scope
    let (vault_id, verify_hash) = keychain_scope_and_hash(&vault_path)?;
    let master_key = keystore::retrieve_master_key(&vault_id)?;

    // The OS keychain is the trust boundary for *who* may unlock; whether the
    // key it released is *this vault's* is proved against the verify hash.
    // A key that fails the proof is removed and biometric unlock is switched
    // off in the config, so the next unlock asks for the password and the
    // user re-enrols from Settings, rather than the app running with a key
    // that opens nothing and seals new secrets under it.
    if keychain_key_belongs_to_vault(&master_key, verify_hash.as_deref()) == Some(false) {
        log::warn!("Biometric key in the keychain does not belong to this vault; removing it");
        match keystore::delete_master_key(&vault_id) {
            Ok(()) | Err(BiometricError::NoCredential) => {}
            Err(e) => log::warn!("Could not remove the stale biometric key: {e}"),
        }
        let _ = keystore::delete_group_key(&vault_id);
        if let Ok(mut config) = init::read_config(&vault_path) {
            config.biometric_mode = "disabled".to_string();
            let _ = init::write_config(&vault_path, &config);
        }
        return Err(BiometricError::WrongVault);
    }

    // And the group key — stored next to the master key since 1.8.2. If
    // the entry is missing (biometric enrolled on an older version), sync
    // will fall back to the legacy behaviour until the next password
    // unlock re-writes both entries.
    let group_key = keystore::retrieve_group_key(&vault_id).unwrap_or(None);

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
    if let Err(e) = super::search::init_search_engine(&vault_path, search_state) {
        log::warn!("Failed to initialize search engine: {e}");
    }

    // Initialize git batch committer
    super::git::init_git_state(&vault_path, git_state);

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
            inbox_state,
            search_state,
            git_state,
            Some(app.clone()),
        );
    }

    Ok(())
}

/// Lightweight biometric verification for UI-lock mode.
///
/// Only prompts the OS biometric dialog and checks brute-force guard.
/// Does NOT retrieve the master key from keychain or re-initialize subsystems,
/// because the vault is already unlocked (master key is in memory). A refused
/// or cancelled prompt counts as a failed attempt.
#[tauri::command]
pub fn biometric_verify(state: State<VaultState>) -> Result<(), BiometricError> {
    let _attempt = begin_brute_force_attempt(&state)?;
    if let Err(e) = prompt::authenticate("Unlock Claspt vault") {
        state.brute_force.record_failure();
        return Err(e);
    }
    state.brute_force.record_success();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_matching_the_verify_hash_belongs_to_the_vault() {
        let key = [7u8; 32];
        let hash = claspt_core::crypto::vault_key::compute_master_key_verify(&key);
        assert_eq!(keychain_key_belongs_to_vault(&key, Some(&hash)), Some(true));
    }

    #[test]
    fn a_key_for_another_vault_is_rejected() {
        let ours = [7u8; 32];
        let theirs = [8u8; 32];
        let hash = claspt_core::crypto::vault_key::compute_master_key_verify(&ours);
        assert_eq!(
            keychain_key_belongs_to_vault(&theirs, Some(&hash)),
            Some(false)
        );
    }

    /// No hash means no proof either way; the caller accepts the key and the
    /// next password unlock writes the hash.
    #[test]
    fn a_vault_without_a_hash_cannot_be_checked() {
        assert_eq!(keychain_key_belongs_to_vault(&[7u8; 32], None), None);
    }
}

/// Disable biometric unlock: remove stored key from keychain and update config.
/// Uses vault path from state instead of caller-supplied parameter (HIGH-2).
#[tauri::command]
pub fn biometric_disable(state: State<VaultState>) -> Result<(), BiometricError> {
    // Derive vault path from trusted state (HIGH-2), and with it the scope the
    // entries live under. Resolved before any deletion so that disabling one
    // vault's biometric cannot remove another vault's keys.
    let vault_path = state
        .vault_path
        .lock()
        .map_err(|_| BiometricError::AuthFailed("lock poisoned".into()))?
        .clone();

    if let Some(ref vp) = vault_path {
        // Adopting first pulls any pre-3.3.34 unscoped entry of ours into the
        // scoped accounts, so the deletion below clears it too rather than
        // leaving it behind for a later unlock to find.
        let vault_id = keychain_scope(vp)?;
        match keystore::delete_master_key(&vault_id) {
            Ok(()) | Err(BiometricError::NoCredential) => {}
            Err(e) => return Err(e),
        }
        // delete_group_key is already idempotent on NoEntry.
        let _ = keystore::delete_group_key(&vault_id);
    }

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
