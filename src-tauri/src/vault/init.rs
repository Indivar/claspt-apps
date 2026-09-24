// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Vault creation, on-disk scaffolding, and config read/write.
//!
//! Builds a fresh Claspt vault directory: the hidden `.securenotes/` metadata
//! folder (holding `config.json`, the encrypted `vault.key`, and the search
//! `index/`), a set of starter content folders, a `.gitignore` that excludes
//! all device-local files, and an initialized git repository with an initial
//! commit. Also owns the atomic 0o600 file writer used for sensitive files,
//! corruption-tolerant config load/save (with a `.bak` fallback), and seeding
//! plus version-refresh of the built-in help pages.
//!
//! Security note: `vault.key` and `config.json` are intentionally git-ignored.
//! Each device derives its own master key from the password, so the key file
//! must never be committed or synced.

use std::path::Path;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use zeroize::Zeroizing;

use super::config::VaultConfig;
use super::error::VaultError;
use crate::crypto::vault_key;
use crate::local_api::auth::{generate_scoped_token, TokenScope};

/// Result of vault creation, returned to the frontend.
#[derive(serde::Serialize)]
pub struct VaultCreationResult {
    /// The recovery key (base64-encoded master key) — shown once to the user.
    pub recovery_key: String,
}

impl std::fmt::Debug for VaultCreationResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VaultCreationResult")
            .field("recovery_key", &"[REDACTED]")
            .finish()
    }
}

/// Atomically write data to a file that is owner-only from its creation.
///
/// Delegates to [`claspt_core::fs_perms::write_owner_only`]: the file is
/// created with the restricted mode rather than restricted after the bytes
/// are in it, flushed, then renamed into place. This used to create the
/// temporary with `std::fs::write` and chmod it afterwards, which left every
/// token file and key file world-readable for the instant between the two.
pub fn write_restricted(path: &Path, data: &[u8]) -> Result<(), VaultError> {
    claspt_core::fs_perms::write_owner_only(path, data)?;
    Ok(())
}

/// Marker lines bounding the section of `.gitignore` that Claspt owns.
///
/// Anything outside the markers belongs to the user and is preserved verbatim
/// by [`reconcile_gitignore`].
pub(crate) const MANAGED_BLOCK_START: &str = "# --- Claspt managed: do not edit below ---";
const MANAGED_BLOCK_END: &str = "# --- end Claspt managed ---";

/// The rules Claspt maintains inside every vault's `.gitignore`.
///
/// This excludes the whole `.securenotes/` directory rather than naming the
/// files inside it. That is a deliberate correction: the previous list
/// enumerated eight filenames and missed four, and each omission was a live
/// leak rather than an inconvenience.
///
/// - `license.json` was never excluded, because the rule said `license.token`
///   while the code wrote `license.json`. The names never matched, so the
///   Ed25519 device entitlement, the device id and the user's email address
///   were committed and pushed to every remote.
/// - `internal/` was absent from both this list and the staging-time removal,
///   so the plaintext usage journal — which records which credential was used,
///   when, and on what domain — was committed and synced.
/// - `device.json` and `last_license_check` were likewise unlisted.
///
/// Nothing under `.securenotes/` is intended to travel between devices: it holds
/// the encrypted master key, the local API tokens, licence state, the search
/// index, sync state, brute-force counters, sharing keys, and the usage journal.
/// Excluding the directory means a file added there in future is covered on the
/// day it is written, instead of on the day someone notices.
const MANAGED_GITIGNORE_RULES: &str = r#"# Vault internals — device-local, never committed or synced. This covers the
# encrypted master key, local API tokens, licence state and email, the search
# index, sync state, brute-force counters, sharing keys and the usage journal.
# The whole directory is excluded on purpose: naming individual files has twice
# let a new one through.
.securenotes/
# The drop folder holds files on their way in, and what could not be taken in.
# A rejected drop can be a plaintext credential file; it is never history.
.inbox/
*.tmp"#;

/// The default `.gitignore` written into a brand-new vault.
fn default_vault_gitignore() -> String {
    format!(
        "# Claspt vault\n\n{MANAGED_BLOCK_START}\n{MANAGED_GITIGNORE_RULES}\n{MANAGED_BLOCK_END}\n"
    )
}

/// Ensure the vault's `.gitignore` carries the current Claspt rules, preserving
/// anything the user added themselves.
///
/// Called on every vault open, not only at creation. `.gitignore` used to be
/// written only when absent, so a vault created before a rule was added never
/// received it — which is why the licence-token and usage-journal exclusions
/// would otherwise have reached no existing user.
///
/// Rules live between [`MANAGED_BLOCK_START`] and [`MANAGED_BLOCK_END`]; that
/// span is replaced wholesale, and everything outside it is left untouched. A
/// file with no markers gets the block appended.
pub fn reconcile_gitignore(vault_dir: &Path) -> Result<(), VaultError> {
    let path = vault_dir.join(".gitignore");
    let managed = format!("{MANAGED_BLOCK_START}\n{MANAGED_GITIGNORE_RULES}\n{MANAGED_BLOCK_END}");

    let existing = match std::fs::read_to_string(&path) {
        Ok(contents) => contents,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            std::fs::write(&path, default_vault_gitignore())?;
            return Ok(());
        }
        Err(e) => return Err(e.into()),
    };

    let updated = match (
        existing.find(MANAGED_BLOCK_START),
        existing.find(MANAGED_BLOCK_END),
    ) {
        (Some(start), Some(end)) if end > start => {
            let after = end + MANAGED_BLOCK_END.len();
            format!("{}{}{}", &existing[..start], managed, &existing[after..])
        }
        // No managed block, or a truncated one: append a fresh block and leave
        // whatever is already there alone.
        _ => {
            let separator = if existing.ends_with('\n') || existing.is_empty() {
                ""
            } else {
                "\n"
            };
            format!("{existing}{separator}\n{managed}\n")
        }
    };

    if updated != existing {
        std::fs::write(&path, updated)?;
    }
    Ok(())
}

/// Initialize a new vault at the given directory.
///
/// Creates:
/// - `.securenotes/` directory with config.json and vault.key
/// - `.securenotes/index/` for search index
/// - `.gitignore` with vault exclusions
/// - Git repository with initial commit
///
/// Returns the master key (for the caller to store in VaultState)
/// and a recovery key string (for one-time display to the user).
/// Whether `dir` contains anything at all.
///
/// An unreadable directory counts as occupied: if we cannot see what is there,
/// the safe answer is to leave it alone.
fn directory_has_entries(dir: &Path) -> bool {
    match std::fs::read_dir(dir) {
        Ok(mut entries) => entries.next().is_some(),
        Err(_) => true,
    }
}

/// What is already at a location the user has chosen for a new vault.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VaultDirState {
    /// Nothing there, or an empty folder. Safe to create.
    Empty,
    /// A complete vault. It should be unlocked, not created over.
    Vault,
    /// A `.securenotes/` directory with no usable `vault.key`: a vault whose
    /// key was moved or whose creation was interrupted. Creating here is
    /// refused, because the remains may still be the only route back to the
    /// data.
    Damaged,
    /// Files that are not a vault. Creating here adds the vault's folders
    /// alongside them and deletes nothing, but the user should know first.
    NotEmpty,
}

/// Inspect a location without touching it.
pub fn inspect_vault_dir(vault_dir: &Path) -> VaultDirState {
    let securenotes = vault_dir.join(".securenotes");
    if securenotes.join("vault.key").exists() {
        return VaultDirState::Vault;
    }
    if securenotes.exists() && directory_has_entries(&securenotes) {
        return VaultDirState::Damaged;
    }
    if !vault_dir.exists() {
        return VaultDirState::Empty;
    }
    // `.DS_Store` and `.localized` are written by the Finder simply for having
    // looked at a folder. Counting them as content would warn about folders
    // the user correctly believes are empty, which teaches people to click
    // past the warning that matters.
    let noise = [".DS_Store", ".localized"];
    let occupied = std::fs::read_dir(vault_dir)
        .map(|entries| {
            entries.flatten().any(|e| {
                let name = e.file_name();
                !noise.contains(&name.to_string_lossy().as_ref())
            })
        })
        .unwrap_or(true);
    if occupied {
        VaultDirState::NotEmpty
    } else {
        VaultDirState::Empty
    }
}

pub fn initialize_vault(
    vault_dir: &Path,
    password: &[u8],
) -> Result<(Zeroizing<Vec<u8>>, VaultCreationResult), VaultError> {
    initialize_vault_with_id(vault_dir, password, None)
}

/// Same as `initialize_vault` but lets the caller pin the `vault_id`. Used by
/// the Restore flow so the new local vault shares the server-side `vault_id`,
/// which is part of the group-key derivation. Generating a fresh id here would
/// produce a group key that can't decrypt the server's existing bundles.
pub fn initialize_vault_with_id(
    vault_dir: &Path,
    password: &[u8],
    override_vault_id: Option<&str>,
) -> Result<(Zeroizing<Vec<u8>>, VaultCreationResult), VaultError> {
    let securenotes = vault_dir.join(".securenotes");

    // Never write over what is already here.
    //
    // This used to test only for `vault.key`, which let a damaged vault — one
    // whose key had been moved, or whose creation was interrupted — be treated
    // as an empty folder. Creation then overwrote `config.json`, taking the
    // vault_id, the API tokens and `master_key_verify` with it and turning a
    // recoverable vault into an unrecoverable one. Anything inside
    // `.securenotes/` means a vault lives here, whole or not.
    if securenotes.exists() && directory_has_entries(&securenotes) {
        return Err(VaultError::AlreadyExists(vault_dir.display().to_string()));
    }

    // Create directory structure. `.securenotes/` is narrowed to the owner
    // before anything is written into it: on Unix that denies other users the
    // traversal they would need to open the files inside at all, and on
    // Windows files created under it inherit the owner-only ACL.
    std::fs::create_dir_all(&securenotes)?;
    claspt_core::fs_perms::restrict_to_owner(&securenotes)?;
    std::fs::create_dir_all(securenotes.join("index"))?;

    // Create default folders — a starter framework users can customize later
    std::fs::create_dir_all(vault_dir.join("general"))?;
    std::fs::create_dir_all(vault_dir.join("credentials"))?;
    std::fs::create_dir_all(vault_dir.join("identities"))?;
    std::fs::create_dir_all(vault_dir.join("personal"))?;
    std::fs::create_dir_all(vault_dir.join("shared"))?;

    // On macOS, create .nosync marker to prevent iCloud from syncing .securenotes/
    #[cfg(target_os = "macos")]
    {
        let nosync_path = securenotes.join(".nosync");
        std::fs::write(&nosync_path, b"")?;
    }

    // Create vault.key (encrypts master key with password)
    let vault_key_path = securenotes.join("vault.key");
    let master_key = vault_key::create_vault_key(password, &vault_key_path)?;

    // Write default config.json with master key verification hash and vault ID
    let mut config = VaultConfig::default();
    if let Some(id) = override_vault_id {
        config.vault_id = Some(id.to_string());
    } else {
        config.ensure_vault_id();
    }
    config.master_key_verify = Some(vault_key::compute_master_key_verify(&master_key));

    // Mint the API tokens now, at creation.
    //
    // They used to be created only by `migrate_api_tokens`, which fires solely
    // when a pre-scoped `clsp_` token already exists — so only vaults old enough
    // to predate scoped tokens ever got any. A brand-new vault had none at all,
    // which meant the Integrations tab showed literal `clsn_…` / `clss_…`
    // placeholders and the browser extension could not be connected without the
    // user first discovering that a token had to be generated by hand. That
    // looked like a platform bug and was reported as one.
    //
    // The local API stays DISABLED (`local_api_enabled` is left unset), so
    // nothing is listening until the user turns it on deliberately. A token that
    // exists while no server is running grants nothing; it is only removing the
    // dead end, not opening a door.
    config.local_api_notes_token = Some(generate_scoped_token(TokenScope::Notes));
    config.local_api_secrets_token = Some(generate_scoped_token(TokenScope::Secrets));

    let config_json = serde_json::to_string_pretty(&config)?;
    write_restricted(&securenotes.join("config.json"), config_json.as_bytes())?;

    // Generate recovery key (base64 of master key — shown once)
    let recovery_key = BASE64.encode(&master_key);

    // Skip the welcome pages + initial commit when we're preparing a vault
    // for a Restore: the server's git history is what we want, and an extra
    // local initial commit would just produce a no-fast-forward conflict
    // when the bundle gets applied.
    let is_restore = override_vault_id.is_some();
    if !is_restore {
        create_welcome_pages(vault_dir);
    }

    // Write .gitignore. Reconciling rather than writing-if-absent means a vault
    // restored from an older backup also picks up the current rules.
    reconcile_gitignore(vault_dir)?;

    // Version history is a convenience layered on top of the vault, not part
    // of it: the pages, the key and the config are already written and usable.
    // A git failure here used to abort the whole call, which reported a
    // created vault as an error and left the user with no way to tell that it
    // existed. Warn and carry on instead.
    let git_result = if is_restore {
        // Only init an empty git repo; the sync pull will populate it with
        // the server's history as its first commit.
        git2::Repository::init(vault_dir)
            .map(|_| ())
            .map_err(VaultError::from)
    } else {
        init_git_repo(vault_dir)
    };
    if let Err(e) = git_result {
        log::warn!(
            "Vault created at {} but version history could not be set up: {e}",
            vault_dir.display()
        );
    }

    let result = VaultCreationResult { recovery_key };
    Ok((master_key, result))
}

/// Initialize a git repository and create an initial commit.
fn init_git_repo(vault_dir: &Path) -> Result<(), VaultError> {
    let repo = git2::Repository::init(vault_dir)?;

    // Stage all files
    let mut index = repo.index()?;
    claspt_core::git::ops::stage_all(&repo, &mut index)?;
    crate::git::ops::unstage_device_local(&mut index);
    index.write()?;
    let tree_oid = index.write_tree()?;
    let tree = repo.find_tree(tree_oid)?;

    // Create initial commit
    let sig = git2::Signature::now("Claspt", "claspt@localhost")?;
    repo.commit(Some("HEAD"), &sig, &sig, "Initial vault setup", &tree, &[])?;

    Ok(())
}

/// Validate that a vault exists at the given path.
pub fn validate_vault_exists(vault_dir: &Path) -> Result<(), VaultError> {
    let securenotes = vault_dir.join(".securenotes");
    if !securenotes.join("vault.key").exists() {
        return Err(VaultError::NotFound(vault_dir.display().to_string()));
    }
    // Every open re-asserts the owner-only mode on the directory. Vaults made
    // before this existed were created at the umask's 0755, and a copy or
    // restore from a backup can widen it again; the cost of setting it each
    // time is one syscall.
    claspt_core::fs_perms::restrict_to_owner(&securenotes)?;
    Ok(())
}

/// Read vault config from disk.
/// Falls back to config.json.bak or default config if the primary file is corrupted.
pub fn read_config(vault_dir: &Path) -> Result<VaultConfig, VaultError> {
    let config_path = vault_dir.join(".securenotes").join("config.json");
    let backup_path = config_path.with_extension("json.bak");

    // Try reading the primary config file
    match std::fs::read_to_string(&config_path) {
        Ok(data) => match serde_json::from_str::<VaultConfig>(&data) {
            Ok(config) => {
                log::debug!(
                    "read_config: markdown_extensions = {:?}",
                    config.markdown_extensions
                );
                return Ok(config);
            }
            Err(e) => {
                log::warn!("config.json is corrupted ({}), trying backup", e);
            }
        },
        Err(e) => {
            log::warn!("Failed to read config.json ({}), trying backup", e);
        }
    }

    // Try the backup
    if backup_path.exists() {
        if let Ok(data) = std::fs::read_to_string(&backup_path) {
            if let Ok(config) = serde_json::from_str::<VaultConfig>(&data) {
                log::warn!("Recovered config from config.json.bak");
                // Restore backup to primary
                let _ = write_restricted(&config_path, data.as_bytes());
                return Ok(config);
            }
        }
    }

    // Last resort: return default config
    log::error!("Both config.json and backup corrupted — using defaults");
    Ok(VaultConfig::default())
}

/// Write vault config to disk with restricted (0o600) permissions.
/// Creates a backup of the current config before overwriting.
pub fn write_config(vault_dir: &Path, config: &VaultConfig) -> Result<(), VaultError> {
    let config_path = vault_dir.join(".securenotes").join("config.json");
    let backup_path = config_path.with_extension("json.bak");
    log::debug!(
        "write_config: markdown_extensions = {:?}",
        config.markdown_extensions
    );

    // Back up the current config before overwriting (best-effort). The backup
    // holds the same material as the original — the local API tokens, the
    // licence key and the master-key verifier — so it is written through
    // `write_restricted` rather than `fs::copy`, whose handling of the
    // destination's permission bits depends on the platform and on whether the
    // destination already existed.
    if let Ok(current) = std::fs::read(&config_path) {
        let _ = write_restricted(&backup_path, &current);
    }

    let json = serde_json::to_string_pretty(config)?;
    write_restricted(&config_path, json.as_bytes())
}

/// Version of the first-run walkthrough. Must match `SETUP_VERSION` in
/// `src/components/setup/SetupWizard.tsx` — the frontend compares against this
/// value to decide whether a vault still needs it.
pub const SETUP_VERSION: u32 = 1;

/// Mark a vault that predates the walkthrough as having already seen it.
///
/// `setup_version_seen` is absent from every vault created before this release,
/// which is indistinguishable from "never ran it" — so without this, upgrading
/// would greet someone with a first-run setup wizard on a vault they have been
/// using for months.
///
/// A vault counts as established if it holds any page outside `help/`. A brand
/// new vault has only the help pages written at creation, so it is left alone
/// and does see the walkthrough, which is the point.
///
/// Best-effort: a vault that cannot be read or written here simply shows the
/// walkthrough, which is a poor greeting but not a fault.
pub fn backfill_setup_seen_for_existing_vault(vault_dir: &Path) {
    let Ok(config) = read_config(vault_dir) else {
        return;
    };
    if config.setup_version_seen.is_some() {
        return;
    }
    if !has_user_pages(vault_dir) {
        return;
    }

    let mut config = config;
    config.setup_version_seen = Some(SETUP_VERSION);
    if let Err(e) = write_config(vault_dir, &config) {
        log::warn!("[vault] Could not mark setup as seen for an existing vault: {e}");
    } else {
        log::info!("[vault] Existing vault marked as having completed setup");
    }
}

/// Whether the vault holds any page the user made, as opposed to only the help
/// pages written when it was created.
fn has_user_pages(vault_dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(vault_dir) else {
        return false;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        // Skip the help pages and the vault's own dot-directories.
        if name == "help" || name.starts_with('.') {
            continue;
        }
        let Ok(pages) = std::fs::read_dir(&path) else {
            continue;
        };
        if pages
            .flatten()
            .any(|p| p.path().extension().is_some_and(|e| e == "md"))
        {
            return true;
        }
    }
    false
}

/// Create welcome/help pages in a new vault. Best-effort — failures are logged.
fn create_welcome_pages(vault_dir: &Path) {
    use crate::pages::crud;

    for (title, body) in super::help_pages::all() {
        if let Err(e) = crud::create_page(vault_dir, title, "help", body, false) {
            log::warn!("Failed to create help page '{title}': {e}");
        }
    }

    // Stamp help pages version so refresh_help_pages() skips on first unlock
    if let Ok(mut config) = read_config(vault_dir) {
        config.help_pages_version = Some(env!("APP_VERSION").to_string());
        let _ = write_config(vault_dir, &config);
    }
}

/// Refresh help pages to match the current app version. Called on every unlock.
pub fn refresh_help_pages(vault_dir: &Path) {
    let app_version = env!("APP_VERSION");

    // Skip if already up to date
    if let Ok(config) = read_config(vault_dir) {
        if config.help_pages_version.as_deref() == Some(app_version) {
            return;
        }
    }

    use crate::pages::crud;

    let help_dir = vault_dir.join("help");

    // Collect existing help page titles -> rel_path
    let mut existing: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    if help_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&help_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().is_none_or(|e| e != "md") {
                    continue;
                }
                let Some(file_name) = path.file_name() else {
                    continue;
                };
                let rel_path = format!("help/{}", file_name.to_string_lossy());
                if let Ok(page) = crud::read_page(vault_dir, &rel_path) {
                    existing.insert(page.meta.title, rel_path);
                }
            }
        }
    }

    // Remove legacy (unnumbered) help pages that have been replaced
    for legacy_title in super::help_pages::legacy_titles() {
        if let Some(rel_path) = existing.remove(legacy_title) {
            if let Err(e) = crud::delete_page(vault_dir, &rel_path) {
                log::warn!("Failed to remove legacy help page '{legacy_title}': {e}");
            }
        }
    }

    // Create or update each help page
    for (title, body) in super::help_pages::all() {
        if let Some(rel_path) = existing.get(title) {
            // Skip pages the user has encrypted — overwriting with plaintext
            // would corrupt them (encrypted: true + plaintext body).
            if let Ok(page) = crud::read_page(vault_dir, rel_path) {
                if page.meta.encrypted {
                    continue;
                }
            }
            if let Err(e) = crud::update_page(vault_dir, rel_path, body) {
                log::warn!("Failed to update help page '{title}': {e}");
            }
        } else if let Err(e) = crud::create_page(vault_dir, title, "help", body, false) {
            log::warn!("Failed to create help page '{title}': {e}");
        }
    }

    // Stamp the version
    if let Ok(mut config) = read_config(vault_dir) {
        config.help_pages_version = Some(app_version.to_string());
        if let Err(e) = write_config(vault_dir, &config) {
            log::warn!("Failed to update help_pages_version in config: {e}");
        }
    }

    log::info!("Refreshed help pages to version {app_version}");
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn test_password() -> &'static [u8] {
        b"test-password-12c"
    }

    #[test]
    fn initialize_vault_creates_structure() {
        let dir = tempdir().unwrap();
        let vault_dir = dir.path();

        let (master_key, result) = initialize_vault(vault_dir, test_password()).unwrap();

        assert_eq!(master_key.len(), 32);
        assert!(!result.recovery_key.is_empty());

        // Check directory structure
        assert!(vault_dir.join(".securenotes").exists());
        assert!(vault_dir.join(".securenotes/config.json").exists());
        assert!(vault_dir.join(".securenotes/vault.key").exists());
        assert!(vault_dir.join(".securenotes/index").exists());
        assert!(vault_dir.join("general").exists());
        assert!(vault_dir.join("credentials").exists());
        assert!(vault_dir.join("identities").exists());
        assert!(vault_dir.join("personal").exists());
        assert!(vault_dir.join(".gitignore").exists());
        assert!(vault_dir.join(".git").exists());
    }

    #[test]
    fn initialize_vault_rejects_existing() {
        let dir = tempdir().unwrap();
        let vault_dir = dir.path();

        initialize_vault(vault_dir, test_password()).unwrap();

        let result = initialize_vault(vault_dir, test_password());
        assert!(result.is_err());
    }

    /// Every file the vault keeps under `.securenotes/` must be ignored by git.
    ///
    /// Asserted through git's own ignore evaluation rather than by matching
    /// strings, because the previous list was checked that way and still missed
    /// four files. `license.json` in particular was never excluded — the ignore
    /// rule named `license.token` while the code wrote `license.json` — so the
    /// signed licence token, the device id and the user's email address were
    /// committed and synced. `internal/` was missing too, which is how the
    /// plaintext usage journal came to be pushed to remotes.
    #[test]
    fn gitignore_excludes_every_vault_internal_file() {
        let dir = tempdir().unwrap();
        let vault_dir = dir.path();

        initialize_vault(vault_dir, test_password()).unwrap();
        let repo = git2::Repository::open(vault_dir).unwrap();

        for path in [
            ".securenotes/vault.key",
            ".securenotes/config.json",
            ".securenotes/config.json.bak",
            ".securenotes/license.json",
            ".securenotes/license.token",
            ".securenotes/device.json",
            ".securenotes/last_license_check",
            ".securenotes/sync.json",
            ".securenotes/brute_force.json",
            ".securenotes/sharing_key.json",
            ".securenotes/index/meta.json",
            ".securenotes/internal/usage-journal.json",
            ".securenotes/internal/automation-rules.json",
            // A file that does not exist yet must be ignored too — the whole
            // point of excluding the directory rather than naming its contents.
            ".securenotes/something-added-later.json",
        ] {
            assert!(
                repo.is_path_ignored(path).unwrap(),
                "{path} is not gitignored and would be committed and synced"
            );
        }

        // Ordinary notes must still be tracked.
        assert!(!repo.is_path_ignored("general/a-note.md").unwrap());
    }

    /// A vault created before an exclusion was added must pick it up.
    ///
    /// `.gitignore` was only ever written when absent, so no existing vault
    /// received a corrected list. That is why the licence-token and usage-journal
    /// exclusions would not have reached anyone already using Claspt.
    #[test]
    fn gitignore_is_reconciled_on_an_existing_vault() {
        let dir = tempdir().unwrap();
        let vault_dir = dir.path();
        initialize_vault(vault_dir, test_password()).unwrap();

        // Simulate a vault whose ignore file predates the current rules, and
        // which carries a rule of the user's own.
        let gitignore_path = vault_dir.join(".gitignore");
        std::fs::write(&gitignore_path, "# my own rules\nscratch/\n").unwrap();

        reconcile_gitignore(vault_dir).unwrap();

        let repo = git2::Repository::open(vault_dir).unwrap();
        assert!(
            repo.is_path_ignored(".securenotes/license.json").unwrap(),
            "reconciliation did not restore the vault-internals exclusion"
        );
        let contents = std::fs::read_to_string(&gitignore_path).unwrap();
        assert!(
            contents.contains("scratch/"),
            "reconciliation discarded the user's own rules"
        );

        // Running it again must not append a second copy.
        reconcile_gitignore(vault_dir).unwrap();
        let twice = std::fs::read_to_string(&gitignore_path).unwrap();
        assert_eq!(
            twice.matches(MANAGED_BLOCK_START).count(),
            1,
            "reconciliation is not idempotent"
        );
    }

    #[test]
    fn initial_commit_does_not_track_config_json() {
        let dir = tempdir().unwrap();
        let vault_dir = dir.path();

        initialize_vault(vault_dir, test_password()).unwrap();

        // config.json exists on disk but must never be committed — it holds the
        // local-API token and license key.
        assert!(vault_dir.join(".securenotes/config.json").exists());
        let repo = git2::Repository::open(vault_dir).unwrap();
        let tree = repo.head().unwrap().peel_to_tree().unwrap();
        assert!(
            tree.get_path(Path::new(".securenotes/config.json"))
                .is_err(),
            "config.json must not be tracked in git"
        );
    }

    #[test]
    fn git_repo_has_initial_commit() {
        let dir = tempdir().unwrap();
        let vault_dir = dir.path();

        initialize_vault(vault_dir, test_password()).unwrap();

        let repo = git2::Repository::open(vault_dir).unwrap();
        let head = repo.head().unwrap();
        let commit = head.peel_to_commit().unwrap();
        assert_eq!(commit.message().unwrap(), "Initial vault setup");
    }

    #[test]
    fn config_read_write_roundtrip() {
        let dir = tempdir().unwrap();
        let vault_dir = dir.path();

        initialize_vault(vault_dir, test_password()).unwrap();

        let config = read_config(vault_dir).unwrap();
        assert_eq!(config.vault_version, "2.0");
        assert_eq!(config.theme, "dark");

        let mut updated = config.clone();
        updated.theme = "light".to_string();
        write_config(vault_dir, &updated).unwrap();

        let reread = read_config(vault_dir).unwrap();
        assert_eq!(reread.theme, "light");
    }

    #[test]
    fn recovery_key_decodes_to_master_key() {
        let dir = tempdir().unwrap();
        let vault_dir = dir.path();

        let (master_key, result) = initialize_vault(vault_dir, test_password()).unwrap();

        let decoded = BASE64.decode(&result.recovery_key).unwrap();
        assert_eq!(decoded, *master_key);
    }

    #[test]
    fn refresh_help_pages_skips_encrypted_pages() {
        use crate::pages::crud;

        let dir = tempdir().unwrap();
        let vault_dir = dir.path();
        initialize_vault(vault_dir, test_password()).unwrap();

        // Stamp a stale version so refresh_help_pages will attempt an update
        let mut config = read_config(vault_dir).unwrap();
        config.help_pages_version = Some("0.0.0".to_string());
        write_config(vault_dir, &config).unwrap();

        // Run refresh once to create the help pages
        refresh_help_pages(vault_dir);

        // Find one of the help pages and mark it as encrypted with ciphertext body
        let help_dir = vault_dir.join("help");
        let entry = std::fs::read_dir(&help_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .find(|e| e.path().extension().is_some_and(|ext| ext == "md"))
            .expect("at least one help page should exist");
        let rel_path = format!("help/{}", entry.file_name().to_string_lossy());

        // Simulate user encrypting the page
        let fake_encrypted = "enc:v1:AAAA_fake_ciphertext";
        crud::update_page_with_meta(vault_dir, &rel_path, fake_encrypted, |meta| {
            meta.encrypted = true;
        })
        .unwrap();

        // Reset version stamp so refresh will try again
        let mut config = read_config(vault_dir).unwrap();
        config.help_pages_version = Some("0.0.0".to_string());
        write_config(vault_dir, &config).unwrap();

        // Run refresh again — it should skip the encrypted page
        refresh_help_pages(vault_dir);

        // Verify the encrypted page was NOT overwritten with plaintext
        let page = crud::read_page(vault_dir, &rel_path).unwrap();
        assert!(page.meta.encrypted, "encrypted flag should be preserved");
        assert!(
            page.content.starts_with("enc:v1:"),
            "encrypted content should be preserved, got: {}",
            &page.content[..page.content.len().min(50)]
        );
    }

    #[test]
    fn nosync_marker_created_on_macos() {
        let dir = tempdir().unwrap();
        let vault_dir = dir.path();

        initialize_vault(vault_dir, test_password()).unwrap();

        let nosync = vault_dir.join(".securenotes").join(".nosync");
        if cfg!(target_os = "macos") {
            assert!(nosync.exists(), ".nosync should exist on macOS");
        }
        // On non-macOS, .nosync may or may not exist — no assertion needed
    }

    /// The config backup carries the same secrets as the config itself — the
    /// local API tokens, the licence key and the master-key verifier — so it
    /// must be no more readable than the original.
    ///
    /// It used to be made with `fs::copy`, which leaves the destination's
    /// permission bits to platform behaviour and to whether the destination
    /// already existed, rather than setting them outright.
    #[cfg(unix)]
    #[test]
    fn the_config_backup_is_no_more_readable_than_the_config() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempdir().unwrap();
        let vault_dir = dir.path();
        initialize_vault(vault_dir, test_password()).unwrap();

        let config_path = vault_dir.join(".securenotes").join("config.json");
        let backup_path = config_path.with_extension("json.bak");

        // Pre-create the backup world-readable, so the test would pass by
        // accident if the write only applied to newly created files.
        std::fs::write(&backup_path, b"stale").unwrap();
        std::fs::set_permissions(&backup_path, std::fs::Permissions::from_mode(0o644)).unwrap();

        // A second write produces the backup.
        let config = read_config(vault_dir).unwrap();
        write_config(vault_dir, &config).unwrap();

        assert!(backup_path.exists(), "no backup was written");
        let mode = std::fs::metadata(&backup_path)
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(
            mode, 0o600,
            "config backup is mode {mode:o}, readable beyond the owner"
        );
    }

    /// A brand-new vault must come with usable API tokens, and with the API off.
    ///
    /// Tokens used to be created only by `migrate_api_tokens`, which fires only
    /// when a pre-scoped `clsp_` token already exists. A fresh vault therefore
    /// had none, the Integrations tab offered `clsn_…` placeholders to copy, and
    /// the browser extension could not be connected at all. It was reported as a
    /// Windows bug; it happened on every platform, and only on fresh installs.
    #[test]
    fn a_new_vault_has_api_tokens_but_the_api_is_off() {
        let dir = tempdir().unwrap();
        let vault_dir = dir.path();
        initialize_vault(vault_dir, test_password()).unwrap();

        let config = read_config(vault_dir).unwrap();

        let notes = config.local_api_notes_token.expect("no notes token minted");
        let secrets = config
            .local_api_secrets_token
            .expect("no secrets token minted");
        assert!(notes.starts_with("clsn_"), "notes token is {notes:.10}…");
        assert!(
            secrets.starts_with("clss_"),
            "secrets token is {secrets:.10}…"
        );
        assert_ne!(notes, secrets, "the two tokens must not be the same value");

        // Nothing is listening until the user asks for it. A token that exists
        // while no server runs grants nothing.
        assert_ne!(
            config.local_api_enabled,
            Some(true),
            "the local API must not be switched on for a new vault"
        );

        // And the legacy token is not created — new vaults are scoped-only.
        assert!(config.local_api_token.is_none());
    }

    /// A vault created before the walkthrough existed must not be shown it.
    ///
    /// `setup_version_seen` is absent from every such vault, which reads
    /// identically to "never ran it" — so without the backfill, upgrading would
    /// greet someone with a first-run wizard on a vault of 2,000 pages.
    #[test]
    fn an_established_vault_is_marked_as_having_completed_setup() {
        let dir = tempdir().unwrap();
        let vault_dir = dir.path();
        initialize_vault(vault_dir, test_password()).unwrap();

        // Simulate a vault from before this release.
        let mut config = read_config(vault_dir).unwrap();
        config.setup_version_seen = None;
        write_config(vault_dir, &config).unwrap();

        // A page the user made, as opposed to the help pages.
        crate::pages::crud::create_page(vault_dir, "My note", "general", "body", false).unwrap();

        backfill_setup_seen_for_existing_vault(vault_dir);

        assert_eq!(
            read_config(vault_dir).unwrap().setup_version_seen,
            Some(SETUP_VERSION),
            "an established vault should not be shown the first-run walkthrough"
        );
    }

    /// A vault that has only just been created must still see the walkthrough.
    /// The help pages written at creation do not count as the user's own.
    #[test]
    fn a_brand_new_vault_still_sees_the_walkthrough() {
        let dir = tempdir().unwrap();
        let vault_dir = dir.path();
        initialize_vault(vault_dir, test_password()).unwrap();

        let mut config = read_config(vault_dir).unwrap();
        config.setup_version_seen = None;
        write_config(vault_dir, &config).unwrap();

        backfill_setup_seen_for_existing_vault(vault_dir);

        assert_eq!(
            read_config(vault_dir).unwrap().setup_version_seen,
            None,
            "a new vault should still be offered the walkthrough"
        );
    }

    /// Running it twice must not overwrite a vault that has genuinely finished
    /// a later version of the walkthrough.
    #[test]
    fn backfill_leaves_an_already_recorded_version_alone() {
        let dir = tempdir().unwrap();
        let vault_dir = dir.path();
        initialize_vault(vault_dir, test_password()).unwrap();
        crate::pages::crud::create_page(vault_dir, "My note", "general", "body", false).unwrap();

        let mut config = read_config(vault_dir).unwrap();
        config.setup_version_seen = Some(99);
        write_config(vault_dir, &config).unwrap();

        backfill_setup_seen_for_existing_vault(vault_dir);

        assert_eq!(read_config(vault_dir).unwrap().setup_version_seen, Some(99));
    }

    #[test]
    fn a_vault_can_be_created_in_a_folder_that_already_holds_a_repository() {
        // Picking a folder that happens to contain a checked-out repository
        // used to fail at the git step with `invalid path: '<dir>/'`, after
        // the key, the config and the welcome pages had already been written.
        // The caller saw an error and had no way to tell a usable vault was
        // sitting there.
        let tmp = tempfile::TempDir::new().unwrap();
        let vault = tmp.path().join("vault");
        std::fs::create_dir_all(&vault).unwrap();

        let nested = vault.join("some-checkout");
        std::fs::create_dir_all(&nested).unwrap();
        git2::Repository::init(&nested).unwrap();
        std::fs::write(nested.join("README.md"), "not ours").unwrap();

        let (master_key, _) = initialize_vault(&vault, b"a-long-test-password").unwrap();
        assert_eq!(master_key.len(), 32);
        assert!(vault.join(".securenotes/vault.key").exists());

        // Version history works, and left the nested repository alone.
        let repo = git2::Repository::open(&vault).unwrap();
        let tree = repo
            .head()
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .tree()
            .unwrap();
        assert!(
            tree.get_path(std::path::Path::new("some-checkout"))
                .is_err(),
            "the nested repository must not be absorbed into the vault history"
        );
    }

    #[test]
    fn a_damaged_vault_is_never_written_over() {
        // A .securenotes holding a config but no vault.key: a vault whose key
        // was moved, or whose creation was interrupted. Creating here used to
        // succeed and overwrite config.json, taking the vault_id and the
        // master key verification hash with it — which is what a recovery
        // would have needed.
        let tmp = tempfile::TempDir::new().unwrap();
        let vault = tmp.path();
        std::fs::create_dir_all(vault.join(".securenotes")).unwrap();
        std::fs::write(
            vault.join(".securenotes/config.json"),
            br#"{"vault_id":"the-only-copy"}"#,
        )
        .unwrap();

        let err = initialize_vault(vault, b"a-long-test-password")
            .expect_err("creating over a damaged vault must be refused");
        assert!(matches!(err, VaultError::AlreadyExists(_)));

        let config = std::fs::read_to_string(vault.join(".securenotes/config.json")).unwrap();
        assert!(
            config.contains("the-only-copy"),
            "the existing config was overwritten"
        );
        assert_eq!(inspect_vault_dir(vault), VaultDirState::Damaged);
    }

    #[test]
    fn a_complete_vault_is_never_written_over() {
        let tmp = tempfile::TempDir::new().unwrap();
        let vault = tmp.path();
        initialize_vault(vault, b"a-long-test-password").unwrap();
        let key_before = std::fs::read(vault.join(".securenotes/vault.key")).unwrap();

        let err = initialize_vault(vault, b"a-different-password")
            .expect_err("creating over a vault must be refused");
        assert!(matches!(err, VaultError::AlreadyExists(_)));

        let key_after = std::fs::read(vault.join(".securenotes/vault.key")).unwrap();
        assert_eq!(key_before, key_after, "the master key was replaced");
        assert_eq!(inspect_vault_dir(vault), VaultDirState::Vault);
    }

    #[test]
    fn a_folder_of_unrelated_files_is_reported_so_the_user_can_be_warned() {
        let tmp = tempfile::TempDir::new().unwrap();
        let dir = tmp.path();
        std::fs::write(dir.join("my-taxes.pdf"), b"important").unwrap();
        assert_eq!(inspect_vault_dir(dir), VaultDirState::NotEmpty);

        // Creating there is allowed — it adds folders beside the files and
        // removes nothing — but the user is told first.
        initialize_vault(dir, b"a-long-test-password").unwrap();
        assert!(dir.join("my-taxes.pdf").exists(), "a user file was removed");
    }

    #[test]
    fn an_empty_folder_and_a_missing_one_are_both_empty() {
        let tmp = tempfile::TempDir::new().unwrap();
        assert_eq!(inspect_vault_dir(tmp.path()), VaultDirState::Empty);
        assert_eq!(
            inspect_vault_dir(&tmp.path().join("does-not-exist")),
            VaultDirState::Empty
        );
    }

    #[test]
    fn a_finder_visit_does_not_make_a_folder_look_occupied() {
        // Warning about a folder the user correctly believes is empty teaches
        // them to click past the warning that matters.
        let tmp = tempfile::TempDir::new().unwrap();
        std::fs::write(tmp.path().join(".DS_Store"), b"finder").unwrap();
        assert_eq!(inspect_vault_dir(tmp.path()), VaultDirState::Empty);
    }

    #[test]
    fn the_inbox_is_never_committed() {
        assert!(MANAGED_GITIGNORE_RULES.contains("\n.inbox/\n"));
    }
}
