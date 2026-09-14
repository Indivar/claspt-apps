// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Tauri IPC commands for vault lifecycle and the crypto engine.
//!
//! This is the security-critical heart of the Tauri backend: creating and unlocking the
//! vault, deriving the master key (Argon2id) from the password, holding the decrypted key
//! and vault path in Tauri managed state (`VaultState`), auto-locking on a timer, and
//! encrypting/decrypting content (AES-256-GCM). Unlocking also boots the dependent
//! subsystems (search index, Git batcher, sync, inbox watcher). Decrypted key material is
//! wrapped in `Zeroizing`/zeroed on lock so it never lingers in memory. Errors surface to
//! the frontend as `VaultError` / `BiometricError`.
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use tauri::{AppHandle, Emitter, State};
use zeroize::Zeroizing;

use super::git::{close_git_state, init_git_state, GitState};
use super::search::{close_search_engine, init_search_engine, SearchState};
use super::sync::{close_sync_state, init_sync_state, SyncState};
use crate::crypto::error::CryptoError;
use crate::crypto::vault_key;
use crate::inbox::{self, InboxState};
use crate::local_api::{self, ApprovalManager, LocalApiState};
use crate::vault::auth::{self, BruteForceGuard};
use crate::vault::config::VaultConfig;
use crate::vault::error::VaultError;
use crate::vault::init::{self, VaultCreationResult};

/// Expand leading `~` or `~/` to the user's home directory.
pub(crate) fn expand_tilde(path: &str) -> PathBuf {
    if let Some(home) = dirs::home_dir() {
        if path == "~" {
            return home;
        }
        if let Some(rest) = path.strip_prefix("~/") {
            return home.join(rest);
        }
    }
    PathBuf::from(path)
}

/// Holds the decrypted master key in memory while the vault is unlocked.
/// Uses `Zeroizing` wrapper so the key is automatically zeroed on drop/replace.
pub struct VaultState {
    pub master_key: Arc<Mutex<Option<Zeroizing<Vec<u8>>>>>,
    /// Deterministic key derived from password for sync bundle encryption.
    /// Same password on any device → same group_key → devices can decrypt each other's bundles.
    pub group_key: Arc<Mutex<Option<Zeroizing<Vec<u8>>>>>,
    pub vault_path: Mutex<Option<PathBuf>>,
    pub brute_force: BruteForceGuard,
    /// Backend UI-lock: last IPC activity timestamp (epoch seconds).
    pub last_activity: Arc<Mutex<u64>>,
    /// Flag to stop the UI-lock watchdog thread.
    pub watchdog_active: Arc<AtomicBool>,
    /// Flag to stop the key-lock watchdog thread.
    pub key_lock_active: Arc<AtomicBool>,
}

impl VaultState {
    pub fn new() -> Self {
        Self {
            master_key: Arc::new(Mutex::new(None)),
            group_key: Arc::new(Mutex::new(None)),
            vault_path: Mutex::new(None),
            brute_force: BruteForceGuard::new(),
            last_activity: Arc::new(Mutex::new(0)),
            watchdog_active: Arc::new(AtomicBool::new(false)),
            key_lock_active: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Record IPC activity to reset the backend auto-lock timer.
    pub fn touch_activity(&self) {
        if let Ok(mut ts) = self.last_activity.lock() {
            *ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
        }
    }

    /// Get the current vault directory, or `None` if the vault is not open.
    pub fn vault_dir(&self) -> Option<PathBuf> {
        self.vault_path.lock().ok()?.clone()
    }

    /// Get a clone of the master key, or `None` if the vault is locked.
    pub fn master_key(&self) -> Option<Zeroizing<Vec<u8>>> {
        self.master_key.lock().ok()?.clone()
    }

    /// Get a clone of the sync group key, or `None` if not derived yet.
    pub fn group_key(&self) -> Option<Zeroizing<Vec<u8>>> {
        self.group_key.lock().ok()?.clone()
    }
}

/// Derive a deterministic sync group key from the raw password and vault ID.
/// Same password + vault_id → same key on every device (desktop and mobile).
/// Uses Argon2id via claspt-core, matching the UniFFI-exposed function used by mobile.
pub fn derive_group_key(password: &[u8], vault_id: &str) -> Zeroizing<Vec<u8>> {
    claspt_core::crypto::group_key::derive_group_key(password, vault_id)
        .expect("group key derivation should not fail with valid inputs")
}

/// Short non-reversible fingerprint of a key, for local debugging only.
///
/// Returns `SHA256(key)[..4]` as hex. The key cannot be recovered from it, but
/// "cannot be recovered" is not the same as "safe to record", and this must stay
/// at `debug` level rather than `info`.
///
/// The reason is the group key specifically. It is `kdf(password, vault_id)`, so
/// a fingerprint written into a log beside its `vault_id` — which is exactly how
/// it was being written — lets anyone holding that log verify a password guess
/// without the vault: derive a candidate group key from the guess and the logged
/// vault_id, hash it, compare four bytes. Thirty-two bits is ample to confirm a
/// hit. Argon2id keeps each guess slow, but the log alone becomes the oracle,
/// with no need for `vault.key` at all.
///
/// Keep call sites at `debug` and do not add new ones that also print the
/// vault_id.
pub fn key_fingerprint(key: &[u8]) -> String {
    use ring::digest::{digest, SHA256};
    let h = digest(&SHA256, key);
    let bytes = h.as_ref();
    format!(
        "{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3]
    )
}

impl Drop for VaultState {
    fn drop(&mut self) {
        // Dropping the Zeroizing<Vec<u8>> wrapper auto-zeroes the key
        if let Ok(mut key) = self.master_key.lock() {
            *key = None;
        }
    }
}

fn get_master_key(state: &State<VaultState>) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    state.touch_activity();
    state
        .master_key()
        .ok_or_else(|| CryptoError::Encryption("vault is locked".into()))
}

/// Create a new vault: validate password, init directory structure, return recovery key.
#[tauri::command]
pub fn create_vault(
    password: String,
    vault_dir: String,
    state: State<VaultState>,
    search_state: State<SearchState>,
    git_state: State<GitState>,
) -> Result<VaultCreationResult, VaultError> {
    // Validate password as &str before converting to zeroed bytes
    auth::validate_password(&password)?;

    let password = Zeroizing::new(password.into_bytes());

    let vault_path = expand_tilde(&vault_dir);
    let (master_key, creation_result) = init::initialize_vault(&vault_path, &password)?;

    // Read config to get the vault_id (created by initialize_vault)
    let config = init::read_config(&vault_path)?;
    let vault_id = config.vault_id.unwrap_or_default();

    let gk = derive_group_key(&password, &vault_id);
    log::debug!(
        "[crypto] create_vault: vault_id={} group_key_fingerprint={}",
        vault_id,
        key_fingerprint(&gk)
    );

    *state
        .master_key
        .lock()
        .map_err(|_| VaultError::LockPoisoned)? = Some(master_key);
    *state
        .group_key
        .lock()
        .map_err(|_| VaultError::LockPoisoned)? = Some(gk);
    *state
        .vault_path
        .lock()
        .map_err(|_| VaultError::LockPoisoned)? = Some(vault_path.clone());

    // Initialize search engine for the new vault
    if let Err(e) = init_search_engine(&vault_path, &search_state) {
        log::warn!("Failed to initialize search engine: {e}");
    }

    // Initialize git batch committer
    init_git_state(&vault_path, &git_state);

    Ok(creation_result)
}

/// Unlock an existing vault with password. Includes brute force protection.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri command wiring several State handles; params-struct refactor tracked as follow-up.
pub fn unlock_vault(
    app: AppHandle,
    password: String,
    vault_dir: String,
    state: State<VaultState>,
    search_state: State<SearchState>,
    git_state: State<GitState>,
    sync_state: State<SyncState>,
    sync_v2: State<super::sync::SyncV2Managed>,
    inbox_state: State<InboxState>,
) -> Result<(), VaultError> {
    let vault_path = expand_tilde(&vault_dir);
    init::validate_vault_exists(&vault_path)?;

    // Load persisted brute force state before checking delay
    state.brute_force.load_from_disk(&vault_path);

    // Atomically check brute force delay and stamp the attempt
    state.brute_force.begin_attempt()?;

    let password = Zeroizing::new(password.into_bytes());

    let vault_key_path = vault_path.join(".securenotes").join("vault.key");
    match vault_key::unlock_vault_key(&password, &vault_key_path) {
        Ok(master_key) => {
            state.brute_force.record_success();

            // Read config once and reuse for both biometric refresh and sync init (LOW-1)
            let mut config = init::read_config(&vault_path).ok();

            // Ensure vault_id exists
            if let Some(ref mut cfg) = config {
                let had_vault_id = cfg.vault_id.is_some();
                cfg.ensure_vault_id();
                if !had_vault_id {
                    let _ = init::write_config(&vault_path, cfg);
                }
            }

            let vault_id = config
                .as_ref()
                .and_then(|c| c.vault_id.as_deref())
                .unwrap_or_default();

            let gk = derive_group_key(&password, vault_id);
            log::debug!(
                "[crypto] unlock_vault: vault_id={} group_key_fingerprint={}",
                vault_id,
                key_fingerprint(&gk)
            );

            // If biometric is enabled, refresh BOTH keychain entries (master
            // key + group key). Pre-1.8.x stored only the master key; biometric
            // unlock then left group_key None and the sync engine fell back
            // to the master key as a group-key substitute — which other
            // devices can't match because they derive the real group key
            // from password + vault_id. Storing both keeps biometric and
            // password unlock state identical.
            if let Some(ref cfg) = config {
                if cfg.biometric_mode != "disabled" {
                    if let Err(e) = crate::biometric::keystore::store_master_key(&master_key) {
                        log::warn!("Failed to refresh keychain master_key: {e}");
                    }
                    if let Err(e) = crate::biometric::keystore::store_group_key(&gk) {
                        log::warn!("Failed to refresh keychain group_key: {e}");
                    }
                }
            }

            *state
                .master_key
                .lock()
                .map_err(|_| VaultError::LockPoisoned)? = Some(master_key);
            *state
                .group_key
                .lock()
                .map_err(|_| VaultError::LockPoisoned)? = Some(gk);
            *state
                .vault_path
                .lock()
                .map_err(|_| VaultError::LockPoisoned)? = Some(vault_path.clone());

            // Signal ensure_engine to drop the cached engine on its next
            // call. We can't take the tokio mutexes here because this is
            // a synchronous Tauri command running on the tokio runtime —
            // calling block_on would deadlock on Windows.
            sync_v2
                .invalidate
                .store(true, std::sync::atomic::Ordering::Release);

            // Initialize search engine
            if let Err(e) = init_search_engine(&vault_path, &search_state) {
                log::warn!("Failed to initialize search engine: {e}");
            }

            // Initialize git batch committer
            init_git_state(&vault_path, &git_state);

            // Start sync scheduler if configured for remote sync
            if let Some(ref cfg) = config {
                if cfg.sync_backend != "local_git" {
                    init_sync_state(
                        &vault_path,
                        &cfg.sync_backend,
                        cfg.sync_remote_url.as_deref(),
                        cfg.sync_interval_seconds,
                        &sync_state,
                    );
                }
            }

            // Trigger background license online check (non-blocking)
            crate::license::validator::maybe_online_check(&vault_path);

            // Auto-start the local API and the SSH agent if enabled. Clients
            // live in the registry, so "enabled" is the only condition.
            if let Some(ref cfg) = config {
                if cfg.local_api_enabled == Some(true) {
                    let port = cfg.local_api_port;
                    let handle = app.clone();
                    tauri::async_runtime::handle().spawn(async move {
                        if let Err(e) = local_api::server::start_server(port, handle).await {
                            log::error!("Local API auto-start failed: {e}");
                        }
                    });
                }
                if cfg.ssh_agent_enabled == Some(true) {
                    use tauri::Manager;
                    if let Err(e) = app
                        .state::<crate::ssh_agent::SshAgentState>()
                        .start(crate::local_api::tauri_services(app.clone()))
                    {
                        log::error!("SSH agent auto-start failed: {e}");
                    }
                }
            }

            // Refresh help pages if app version changed
            crate::vault::init::refresh_help_pages(&vault_path);

            // Bring the vault's .gitignore up to the current rules. Vaults
            // created before an exclusion was added never received it, so this
            // is how an existing vault stops committing its licence state and
            // usage journal. Already-tracked copies are dropped from the index
            // by `unstage_device_local` on the next commit.
            if let Err(e) = crate::vault::init::reconcile_gitignore(&vault_path) {
                log::warn!("[vault] Could not reconcile .gitignore: {e}");
            }

            // A vault that predates the setup walkthrough should not be shown
            // it — see `backfill_setup_seen_for_existing_vault`.
            crate::vault::init::backfill_setup_seen_for_existing_vault(&vault_path);

            // Tokens from before the client registry (shared notes/secrets/
            // legacy slots, in the keychain or config.json) become named,
            // hashed client records; the plaintext is removed from both places.
            if let Some(ref mut cfg) = config {
                match crate::local_api::clients::migrate_from_slots(&vault_path, cfg) {
                    Ok(moved) if moved > 0 => {
                        if let Err(e) = init::write_config(&vault_path, cfg) {
                            log::warn!("[vault] Migrated {moved} API token(s) but could not rewrite config: {e}");
                        } else {
                            log::info!(
                                "[vault] Migrated {moved} API token(s) into the client registry"
                            );
                        }
                    }
                    Ok(_) => {}
                    Err(e) => log::warn!("[vault] API token migration failed: {e}"),
                }
            }

            // Start backend auto-lock watchdog
            state.touch_activity();
            let auto_lock_mins = config.as_ref().map(|c| c.auto_lock_minutes).unwrap_or(15);
            if auto_lock_mins > 0 {
                state.watchdog_active.store(true, Ordering::Relaxed);
                let activity = Arc::clone(&state.last_activity);
                let active = Arc::clone(&state.watchdog_active);
                let app_handle = app.clone();
                let timeout = Duration::from_secs(u64::from(auto_lock_mins) * 60);
                std::thread::spawn(move || {
                    while active.load(Ordering::Relaxed) {
                        std::thread::sleep(Duration::from_secs(30));
                        if !active.load(Ordering::Relaxed) {
                            break;
                        }
                        let last = match activity.lock() {
                            Ok(guard) => *guard,
                            Err(_) => break,
                        };
                        let now = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs();
                        if last > 0 && now.saturating_sub(last) >= timeout.as_secs() {
                            log::info!(
                                "Backend auto-lock: timeout reached after {auto_lock_mins}m"
                            );
                            let _ = app_handle.emit("vault-auto-lock", ());
                            active.store(false, Ordering::Relaxed);
                            break;
                        }
                    }
                });
            }

            // Start key-lock watchdog (zeros master key after the timeout).
            // key_lock_minutes == 0 means "tie to the UI auto-lock" so a locked
            // vault stops decrypting secrets instead of holding the key forever;
            // a non-zero value is an explicit hard-lock timeout. Fail safe to 15
            // if config is unreadable.
            let key_lock_mins = {
                let explicit = config.as_ref().map(|c| c.key_lock_minutes).unwrap_or(0);
                if explicit > 0 {
                    explicit
                } else {
                    config.as_ref().map(|c| c.auto_lock_minutes).unwrap_or(15)
                }
            };
            if key_lock_mins > 0 {
                state.key_lock_active.store(true, Ordering::Relaxed);
                let activity = Arc::clone(&state.last_activity);
                let active = Arc::clone(&state.key_lock_active);
                let master_key_ref = Arc::clone(&state.master_key);
                let app_handle = app.clone();
                let timeout = Duration::from_secs(u64::from(key_lock_mins) * 60);
                std::thread::spawn(move || {
                    while active.load(Ordering::Relaxed) {
                        std::thread::sleep(Duration::from_secs(30));
                        if !active.load(Ordering::Relaxed) {
                            break;
                        }
                        let last = match activity.lock() {
                            Ok(guard) => *guard,
                            Err(_) => break,
                        };
                        let now = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs();
                        if last > 0 && now.saturating_sub(last) >= timeout.as_secs() {
                            log::info!(
                                "Key lock: zeroing master key after {key_lock_mins}m of inactivity"
                            );
                            // Zero the master key directly
                            if let Ok(mut key) = master_key_ref.lock() {
                                *key = None;
                            }
                            let _ = app_handle.emit("vault-key-locked", ());
                            active.store(false, Ordering::Relaxed);
                            break;
                        }
                    }
                });
            }

            // Start agent memory TTL cleanup (hourly)
            {
                let active = Arc::clone(&state.watchdog_active);
                let vault_path_clone = vault_path.clone();
                std::thread::spawn(move || {
                    while active.load(Ordering::Relaxed) {
                        // Sleep 1 hour in 30s increments (so we check the flag)
                        for _ in 0..120 {
                            if !active.load(Ordering::Relaxed) {
                                return;
                            }
                            std::thread::sleep(Duration::from_secs(30));
                        }
                        if !active.load(Ordering::Relaxed) {
                            break;
                        }
                        // Read the retention setting fresh each run: the user may have
                        // changed it in Settings since the thread started.
                        let retention = crate::vault::init::read_config(&vault_path_clone)
                            .map(|c| crate::pages::agent_memory::KindRetention::from_config(&c))
                            .unwrap_or_default();
                        match crate::pages::agent_memory::cleanup_expired(
                            &vault_path_clone,
                            &retention,
                        ) {
                            Ok(0) => {}
                            Ok(n) => {
                                log::info!("Agent memory TTL cleanup: deleted {n} expired memories")
                            }
                            Err(e) => log::warn!("Agent memory TTL cleanup failed: {e}"),
                        }
                    }
                });
            }

            // Rotation reminders: compare every stored password's age with the
            // owner's limit once per unlock, off the UI thread. Alerts land in
            // Settings > Automation like the other security alerts.
            if let Some(mk) = state.master_key() {
                let vault_for_rotation = vault_path.clone();
                std::thread::spawn(move || {
                    let days = crate::vault::init::read_config(&vault_for_rotation)
                        .map(|c| c.rotation_reminder_days)
                        .unwrap_or(0);
                    match crate::utilities::rotation::refresh_alerts(
                        &vault_for_rotation,
                        &mk,
                        days,
                        chrono::Utc::now(),
                    ) {
                        Ok((0, 0)) => {}
                        Ok((added, resolved)) => {
                            log::info!("Rotation reminders: {added} raised, {resolved} resolved")
                        }
                        Err(e) => log::warn!("Rotation reminder check failed: {e}"),
                    }
                });
            }

            // Start inbox watcher
            if let Some(mk) = state.master_key() {
                inbox::start_inbox_watcher(
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
        Err(e) => {
            state.brute_force.record_failure();
            Err(e.into())
        }
    }
}

/// UI lock: hides the interface but keeps the backend fully operational.
///
/// The master key stays in memory so API/MCP/browser extension continue working.
/// The frontend shows the lock screen and requires re-authentication to access the UI.
/// A separate key-lock watchdog (`key_lock_minutes`) handles zeroing the master key.
#[tauri::command]
pub fn lock_vault(
    state: State<VaultState>,
    _search_state: State<SearchState>,
    _git_state: State<GitState>,
    _sync_state: State<SyncState>,
    _api_state: State<LocalApiState>,
    _approval_state: State<ApprovalManager>,
    _inbox_state: State<InboxState>,
) -> Result<(), VaultError> {
    // Stop the UI-lock watchdog (it already fired)
    state.watchdog_active.store(false, Ordering::Relaxed);

    // Everything else stays running: API server, search, git, sync, inbox.
    // The master key stays in memory for API/MCP access.
    // The frontend handles showing the lock screen.
    Ok(())
}

/// Key lock: zero master key from memory, close heavy backend resources.
///
/// Called by the key-lock watchdog after `key_lock_minutes`, or when the app is quitting.
/// After this, API/MCP can still read pages but cannot decrypt secrets.
#[tauri::command]
pub fn key_lock_vault(
    state: State<VaultState>,
    search_state: State<SearchState>,
    git_state: State<GitState>,
    sync_state: State<SyncState>,
    _api_state: State<LocalApiState>,
    approval_state: State<ApprovalManager>,
    limiter: State<crate::local_api::SecretReadLimiter>,
    inbox_state: State<InboxState>,
) -> Result<(), VaultError> {
    // Stop key-lock watchdog
    state.key_lock_active.store(false, Ordering::Relaxed);

    // Clear secret access approvals and the per-client read windows
    approval_state.clear_session();
    limiter.clear();

    // Stop inbox watcher
    inbox::stop_inbox_watcher(&inbox_state);

    // API server stays running — routes return 403 for secret decryption

    // Stop sync scheduler
    close_sync_state(&sync_state);

    // Flush pending git commits and close
    close_git_state(&git_state);

    // Close search engine
    close_search_engine(&search_state);

    // Zero the master key — secrets become inaccessible
    *state
        .master_key
        .lock()
        .map_err(|_| VaultError::LockPoisoned)? = None;

    // Keep vault_path — pages can still be read from disk (secrets just won't decrypt)

    Ok(())
}

/// Reset the activity timer (called on UI re-auth from lock screen).
///
/// This resets both the UI-lock and key-lock watchdog timers, and restarts
/// the UI-lock watchdog if it was stopped.
#[tauri::command]
pub fn touch_activity(state: State<VaultState>) -> Result<(), String> {
    state.touch_activity();
    // Restart UI-lock watchdog if it was stopped (user re-authenticated from lock screen)
    if !state.watchdog_active.load(Ordering::Relaxed) && state.master_key().is_some() {
        state.watchdog_active.store(true, Ordering::Relaxed);
    }
    Ok(())
}

/// Read vault config.
#[tauri::command]
pub fn get_vault_config(state: State<VaultState>) -> Result<VaultConfig, VaultError> {
    let vault_path = state
        .vault_path
        .lock()
        .map_err(|_| VaultError::LockPoisoned)?;
    let vault_path = vault_path
        .as_ref()
        .ok_or_else(|| VaultError::NotFound("no vault open".into()))?;
    init::read_config(vault_path)
}

/// Update vault config.
#[tauri::command]
pub fn set_vault_config(config: VaultConfig, state: State<VaultState>) -> Result<(), VaultError> {
    // Validate config values before persisting
    config.validate()?;

    let vault_path = state
        .vault_path
        .lock()
        .map_err(|_| VaultError::LockPoisoned)?;
    let vault_path = vault_path
        .as_ref()
        .ok_or_else(|| VaultError::NotFound("no vault open".into()))?;
    init::write_config(vault_path, &config)
}

/// Verify the vault password without re-unlocking.
///
/// Re-derives the key from the password and the vault.key salt, then attempts
/// decryption. On success returns Ok(()); on failure records a brute-force
/// attempt and returns an error.
#[tauri::command]
pub async fn verify_password(
    password: String,
    state: State<'_, VaultState>,
) -> Result<(), VaultError> {
    state.brute_force.begin_attempt()?;

    let password = Zeroizing::new(password.into_bytes());

    let vault_path = state
        .vault_path
        .lock()
        .map_err(|_| VaultError::LockPoisoned)?
        .clone()
        .ok_or_else(|| VaultError::NotFound("no vault open".into()))?;

    // Run KDF (Argon2id, intentionally slow) on a blocking thread
    let result = tokio::task::spawn_blocking(move || {
        let vault_key_path = vault_path.join(".securenotes").join("vault.key");
        vault_key::unlock_vault_key(&password, &vault_key_path)
    })
    .await
    .map_err(|_| VaultError::LockPoisoned)?;

    match result {
        Ok(_) => {
            state.brute_force.record_success();
            Ok(())
        }
        Err(_) => {
            state.brute_force.record_failure();
            Err(VaultError::WrongPassword)
        }
    }
}

/// Recover vault using a recovery key: validates key, re-encrypts vault.key
/// with new password, unlocks vault.
#[tauri::command]
pub fn recover_with_key(
    recovery_key: String,
    new_password: String,
    vault_dir: String,
    state: State<VaultState>,
    search_state: State<SearchState>,
    git_state: State<GitState>,
    sync_state: State<SyncState>,
) -> Result<VaultCreationResult, VaultError> {
    // Brute force protection applies to recovery attempts too
    state.brute_force.begin_attempt()?;

    // Validate new password
    auth::validate_password(&new_password)?;

    let new_password = Zeroizing::new(new_password.into_bytes());
    let vault_path = expand_tilde(&vault_dir);
    init::validate_vault_exists(&vault_path)?;

    // Load config for verification hash and vault_id
    let config = init::read_config(&vault_path).ok();
    let verify_hash = config.as_ref().and_then(|c| c.master_key_verify.clone());
    let vault_id = config
        .as_ref()
        .and_then(|c| c.vault_id.as_deref())
        .unwrap_or_default();

    let vault_key_path = vault_path.join(".securenotes").join("vault.key");
    match vault_key::recover_with_key(
        &recovery_key,
        &new_password,
        &vault_key_path,
        verify_hash.as_deref(),
    ) {
        Ok(master_key) => {
            state.brute_force.record_success();

            // Store the recovery key (base64 of master key) for display
            let new_recovery_key = base64::engine::general_purpose::STANDARD.encode(&*master_key);

            *state
                .master_key
                .lock()
                .map_err(|_| VaultError::LockPoisoned)? = Some(master_key);
            *state
                .group_key
                .lock()
                .map_err(|_| VaultError::LockPoisoned)? =
                Some(derive_group_key(&new_password, vault_id));
            *state
                .vault_path
                .lock()
                .map_err(|_| VaultError::LockPoisoned)? = Some(vault_path.clone());

            // Initialize search engine
            if let Err(e) = init_search_engine(&vault_path, &search_state) {
                log::warn!("Failed to initialize search engine: {e}");
            }

            // Initialize git batch committer
            init_git_state(&vault_path, &git_state);

            // Start sync if configured
            if let Ok(cfg) = init::read_config(&vault_path) {
                if cfg.sync_backend != "local_git" {
                    init_sync_state(
                        &vault_path,
                        &cfg.sync_backend,
                        cfg.sync_remote_url.as_deref(),
                        cfg.sync_interval_seconds,
                        &sync_state,
                    );
                }
            }

            Ok(VaultCreationResult {
                recovery_key: new_recovery_key,
            })
        }
        Err(e) => {
            state.brute_force.record_failure();
            Err(e.into())
        }
    }
}

/// Reset vault settings to defaults without touching content or keys.
/// Resets: theme, fonts, scale, auto-save, secret timing, extensions, help pages.
/// Does NOT touch: vault content, vault.key, license, sync settings, git history.
#[tauri::command]
pub fn reset_to_defaults(state: State<VaultState>) -> Result<serde_json::Value, VaultError> {
    let vault_dir = state
        .vault_dir()
        .ok_or_else(|| VaultError::NotFound("no vault open".into()))?;

    // Read current config to preserve non-resettable fields
    let mut config = init::read_config(&vault_dir)?;

    // Reset appearance
    config.theme = "dark".to_string();
    config.editor_font_family = "JetBrains Mono".to_string();
    config.editor_font_size = 14;
    config.ui_scale = 1.0;

    // Reset editor behavior
    config.auto_save_delay_ms = 5000;
    config.secret_auto_hide_seconds = 30;
    config.clipboard_clear_seconds = 30;

    // Reset security (non-destructive defaults)
    config.auto_lock_minutes = 15;
    config.encrypted_page_display = "blur".to_string();

    // Reset extensions to all enabled
    config.markdown_extensions = None; // None = use DEFAULT_ENABLED (which is now all)

    // Reset help pages version to force refresh on next unlock
    config.help_pages_version = None;

    // Write config
    init::write_config(&vault_dir, &config)?;

    // Ensure default folders exist (don't touch existing ones)
    let default_folders = ["general", "credentials", "identities", "personal", "shared"];
    for folder in &default_folders {
        let dir = vault_dir.join(folder);
        if !dir.exists() {
            let _ = std::fs::create_dir_all(&dir);
        }
    }

    // Refresh help pages immediately
    crate::vault::init::refresh_help_pages(&vault_dir);

    Ok(serde_json::json!({
        "ok": true,
        "message": "Settings reset to defaults. Help pages refreshed. Missing folders created."
    }))
}

/// Encrypt a secret block value.
#[tauri::command]
pub fn encrypt_block(plaintext: String, state: State<VaultState>) -> Result<String, CryptoError> {
    let master_key = get_master_key(&state)?;
    vault_key::encrypt_block(&master_key, &plaintext)
}

/// Decrypt a secret block value.
///
/// NOTE: The `Zeroizing<String>` from `decrypt_block` is converted to a regular
/// `String` for Tauri IPC. Once the value crosses the IPC boundary into WebView
/// memory, Rust can no longer zeroize it. This is an inherent Tauri limitation.
#[tauri::command]
pub fn decrypt_block(encoded: String, state: State<VaultState>) -> Result<String, CryptoError> {
    let master_key = get_master_key(&state)?;
    let plaintext = vault_key::decrypt_block(&master_key, &encoded)?;
    Ok(plaintext.to_string())
}

/// Returns the inner logic for default vault dir suggestion (testable without Tauri state).
fn suggest_default_vault_dir_inner() -> String {
    // On macOS and Windows, use Documents/Claspt.
    // On Linux, use ~/Claspt (~/Documents may not exist).
    #[cfg(target_os = "linux")]
    let base = dirs::home_dir();
    #[cfg(not(target_os = "linux"))]
    let base = dirs::document_dir().or_else(dirs::home_dir);

    match base {
        Some(dir) => dir.join("Claspt").to_string_lossy().to_string(),
        None => "~/Claspt".to_string(),
    }
}

/// Whether a Claspt vault already exists at this path.
///
/// The unlock screen used to open in "unlock" mode unconditionally, because it
/// had no way to ask this. On a first install that meant showing a path to a
/// vault that did not exist, a password box, and an Unlock button that could
/// only fail — leaving a new user to work out for themselves that they wanted
/// the Create tab. This lets the screen open in the right mode instead.
///
/// A path that cannot be read counts as "no vault": the caller uses this to
/// choose which form to show, and offering to create is recoverable, whereas
/// asking someone to unlock something that is not there is a dead end.
#[tauri::command]
pub fn vault_exists_at(path: String) -> bool {
    if path.trim().is_empty() {
        return false;
    }
    init::validate_vault_exists(std::path::Path::new(&path)).is_ok()
}

/// Suggest a platform-appropriate default vault directory.
#[tauri::command]
pub fn suggest_default_vault_dir() -> String {
    suggest_default_vault_dir_inner()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suggest_default_vault_dir_returns_path() {
        let path = suggest_default_vault_dir_inner();
        assert!(
            path.contains("Claspt"),
            "Expected path to contain 'Claspt', got: {path}"
        );
        assert!(!path.is_empty());
    }
}
