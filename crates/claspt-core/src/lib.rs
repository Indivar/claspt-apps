// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! `claspt-core`: the shared cryptography, sync-bundle, secret-parsing, and git
//! engine behind Claspt on every platform. The desktop app (Tauri/Rust) links it
//! directly; the mobile apps (iOS/Android) call the same compiled code through the
//! UniFFI bindings generated from [`claspt_core.udl`](../src/claspt_core.udl). One
//! implementation means one audited crypto path rather than a re-implementation
//! per platform.
//!
//! # Key hierarchy
//!
//! Claspt derives everything from a single user password. Two independent keys hang
//! off it:
//!
//! - **Master key** — a random 256-bit key generated once per vault by
//!   [`crypto::aead::generate_master_key`]. It is the key that actually encrypts
//!   secret block values. It is never derived from the password directly; instead
//!   the password is stretched with Argon2id into a *password key*
//!   ([`crypto::kdf::derive_key`]) which then wraps (AES-256-GCM encrypts) the
//!   master key inside the `vault.key` file. This indirection means changing the
//!   password only re-wraps the master key — existing ciphertext never has to be
//!   re-encrypted. See [`crypto::vault_key`].
//! - **Sync group key** — a separate 256-bit key derived deterministically from
//!   `password + vault_id` via [`crypto::group_key::derive_group_key`]. It encrypts
//!   sync bundles in transit and is intentionally *not* the master key, so the sync
//!   server (or a wire attacker) never sees anything derived from the key that
//!   guards on-disk secrets. Because the salt is bound to `vault_id`, two vaults
//!   with the same password still get different group keys.
//!
//! All key material is held in `zeroize::Zeroizing` wrappers so it is scrubbed from
//! memory on drop.
//!
//! # What is and isn't encrypted
//!
//! Claspt notes are portable `.md` files, so most of the content stays plaintext on
//! disk for grep-ability and durability:
//!
//! - **Encrypted:** only secret block *values* — the body between a
//!   `:::secret[Label]` fence and its closing `:::`. Each block is sealed with
//!   AES-256-GCM under a fresh random nonce. See [`pages::secret`].
//! - **Plaintext:** secret block *labels*, page titles, folder names, tags, and all
//!   non-secret markdown content. These are deliberately left readable so a note
//!   remains a usable markdown file even without Claspt.
//!
//! Sync bundles are the exception: a bundle is a git packfile of the whole vault
//! and is fully encrypted under the group key before it ever leaves the device, so
//! plaintext content is protected in transit even though it is plaintext at rest.
//!
//! # Format-version table
//!
//! Every persisted/serialized artifact carries an explicit version so formats can
//! evolve without silently corrupting older data:
//!
//! | Artifact              | Version marker      | Layout (summary)                                                              |
//! |-----------------------|---------------------|-------------------------------------------------------------------------------|
//! | `vault.key` file      | leading byte `0x01` | `version(1) ‖ salt(16) ‖ nonce(12) ‖ AES-GCM(master_key)(32) ‖ tag(16)`        |
//! | Secret block on disk  | `enc:v1:` prefix    | `enc:v1:` + base64(`nonce(12) ‖ ciphertext ‖ tag(16)`)                         |
//! | Sync bundle           | magic `CSYNC1`, `0x01` | `CSYNC1(6) ‖ ver(1) ‖ type(1) ‖ nonce(12) ‖ device_prefix(8) ‖ reserved(4)` header, then AES-GCM(bundle) with the header as AAD |
//!
//! See [`crypto::vault_key`], [`pages::secret`], and [`sync::encrypt`] for the
//! authoritative definitions.
//!
//! # Module map
//!
//! - [`crypto`] — AEAD primitive, Argon2id KDF, vault-key wrapping, sync group key.
//! - [`sync`] — encrypted transport envelope and pure-`git2` bundle create/apply.
//! - [`pages`] — secret block parsing/encryption and page (frontmatter) model.
//! - [`git`] — auto-commit and version-history queries over the vault repo.

// The UniFFI scaffolding included below (`include_scaffolding!`) is generated
// code that trips this cosmetic doc-comment lint. Our own source does not, so
// scope the allow to this one lint at the crate level to keep `-D warnings` CI
// green without silencing anything in hand-written code.
#![allow(clippy::empty_line_after_doc_comments)]

pub mod crypto;
pub mod fs_perms;
pub mod git;
pub mod pages;
#[cfg(feature = "pro")]
pub mod sync;

// Re-export key types for Rust consumers (desktop)
pub use crypto::error::CryptoError;
pub use git::error::GitError;
pub use pages::error::PageError;
#[cfg(feature = "pro")]
pub use sync::error::SyncError;

// UniFFI scaffolding
uniffi::include_scaffolding!("claspt_core");

// --- UniFFI-compatible error type ---

/// Flat error type crossing the FFI boundary to the mobile apps.
///
/// The internal crate uses rich, module-specific error enums ([`CryptoError`],
/// [`GitError`], [`SyncError`], [`PageError`]); those are collapsed here into a
/// small set of string-carrying variants because UniFFI can only marshal a flat
/// enum. Consumers should treat the payload as a human-readable message, not a
/// stable machine code. Variant meanings:
/// - `CryptoError` — encryption, decryption, or key-derivation failure (commonly a
///   wrong password or corrupted `vault.key`/ciphertext).
/// - `GitError` — a git2 operation failed (bad OID, repo not found, etc.).
/// - `SyncError` — a sync-bundle create/apply/encode step failed.
/// - `IoError` — an underlying filesystem read/write failed.
/// - `InvalidData` — input did not match the expected format (bad frontmatter,
///   malformed base64, etc.).
#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error("crypto error: {0}")]
    CryptoError(String),
    #[error("git error: {0}")]
    GitError(String),
    #[error("sync error: {0}")]
    SyncError(String),
    #[error("I/O error: {0}")]
    IoError(String),
    #[error("invalid data: {0}")]
    InvalidData(String),
}

impl From<CryptoError> for CoreError {
    fn from(e: CryptoError) -> Self {
        CoreError::CryptoError(e.to_string())
    }
}

impl From<GitError> for CoreError {
    fn from(e: GitError) -> Self {
        CoreError::GitError(e.to_string())
    }
}

#[cfg(feature = "pro")]
impl From<SyncError> for CoreError {
    fn from(e: SyncError) -> Self {
        CoreError::SyncError(e.to_string())
    }
}

impl From<PageError> for CoreError {
    fn from(e: PageError) -> Self {
        match e {
            PageError::Io(e) => CoreError::IoError(e.to_string()),
            other => CoreError::InvalidData(other.to_string()),
        }
    }
}

impl From<std::io::Error> for CoreError {
    fn from(e: std::io::Error) -> Self {
        CoreError::IoError(e.to_string())
    }
}

// --- UniFFI-compatible enums and structs ---

/// Which kind of sync bundle a payload carries.
///
/// - `Incremental` — only the commits since a known baseline OID; small, the
///   common case for ongoing sync.
/// - `Snapshot` — the entire repository history; used for the first sync to a new
///   device or to recover from a diverged baseline.
///
/// This is the public FFI mirror of the internal [`sync::encrypt::WireBundleType`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BundleType {
    Incremental,
    Snapshot,
}

#[cfg(feature = "pro")]
impl From<BundleType> for sync::encrypt::WireBundleType {
    fn from(bt: BundleType) -> Self {
        match bt {
            BundleType::Incremental => sync::encrypt::WireBundleType::Incremental,
            BundleType::Snapshot => sync::encrypt::WireBundleType::Snapshot,
        }
    }
}

#[cfg(feature = "pro")]
impl From<sync::encrypt::WireBundleType> for BundleType {
    fn from(wbt: sync::encrypt::WireBundleType) -> Self {
        match wbt {
            sync::encrypt::WireBundleType::Incremental => BundleType::Incremental,
            sync::encrypt::WireBundleType::Snapshot => BundleType::Snapshot,
        }
    }
}

/// Plaintext result of decrypting a sync bundle.
pub struct DecryptedBundle {
    /// The decrypted git bundle bytes, ready to feed to [`apply_git_bundle`].
    pub data: Vec<u8>,
    /// Whether the bundle was incremental or a full snapshot.
    pub bundle_type: BundleType,
    /// First 8 characters of the originating device's ID, or `None` if the sender
    /// wrote no device prefix. Read from the authenticated header before decryption
    /// so it can be trusted for origin display.
    pub device_prefix: Option<String>,
}

/// Outcome of applying a bundle to the local vault repository.
pub struct ApplyResult {
    /// Number of new commits that landed on HEAD (0 if up-to-date or a merge is
    /// required).
    pub commits_applied: u32,
    /// `true` when histories diverged and a fast-forward was not possible, so the
    /// caller must run a real merge.
    pub needs_merge: bool,
    /// Human-readable descriptions of why a fast-forward was refused; empty on a
    /// clean apply.
    pub conflicts: Vec<String>,
}

/// Result of an auto-commit.
pub struct CommitResult {
    /// The new commit's OID as a 40-char hex string, or empty if nothing changed.
    pub oid: String,
    /// The commit message that was recorded.
    pub message: String,
}

/// One entry in a file's or vault's commit history.
pub struct GitCommitEntry {
    /// Commit OID as a 40-char hex string.
    pub oid: String,
    /// Full commit message.
    pub message: String,
    /// Commit time as Unix epoch seconds (UTC).
    pub timestamp_secs: i64,
}

/// A single file's before/after contents at one commit, for version-history diffs.
pub struct GitCommitDiff {
    /// Commit OID as a 40-char hex string.
    pub oid: String,
    /// Full commit message.
    pub message: String,
    /// Commit time as Unix epoch seconds (UTC).
    pub timestamp_secs: i64,
    /// File contents at the parent commit; `None` means the file was created here.
    pub parent_content: Option<String>,
    /// File contents at this commit; `None` means the file was deleted here.
    pub current_content: Option<String>,
}

// --- FFI wrapper functions ---

use std::path::Path;

/// Encrypt a single secret block value under `master_key`, returning an
/// `enc:v1:`-less base64 string (`nonce ‖ ciphertext ‖ tag`). `master_key` must be
/// 32 bytes.
fn encrypt_block(master_key: &[u8], plaintext: String) -> Result<String, CoreError> {
    let encoded = crypto::vault_key::encrypt_block(master_key, &plaintext)?;
    Ok(encoded)
}

/// Decrypt a base64 secret block value produced by [`encrypt_block`]. Returns
/// `CoreError::CryptoError` if the key is wrong or the ciphertext is corrupt.
fn decrypt_block(master_key: &[u8], encoded: String) -> Result<String, CoreError> {
    let plain = crypto::vault_key::decrypt_block(master_key, &encoded)?;
    Ok(plain.to_string())
}

/// Generate a fresh random 32-byte (256-bit) master key.
fn generate_master_key() -> Result<Vec<u8>, CoreError> {
    let key = crypto::aead::generate_master_key()?;
    Ok(key.to_vec())
}

/// Stretch `password` with `salt` via Argon2id into a 32-byte key. `salt` should be
/// at least 16 bytes; the same `(password, salt)` always yields the same key.
fn derive_key(password: &[u8], salt: &[u8]) -> Result<Vec<u8>, CoreError> {
    let key = crypto::kdf::derive_key(password, salt)?;
    Ok(key.to_vec())
}

/// Derive the 32-byte sync group key for `(password, vault_id)`. Deterministic and
/// distinct from the master key; used only for sync-bundle encryption.
fn derive_group_key(password: &[u8], vault_id: String) -> Result<Vec<u8>, CoreError> {
    let key = crypto::group_key::derive_group_key(password, &vault_id)?;
    Ok(key.to_vec())
}

/// Create a new vault: generate a master key, wrap it under `password`, and write
/// the `vault.key` file at `vault_key_path` (0o600 on Unix). Returns the plaintext
/// master key. The parent directory must already exist.
fn create_vault_key(password: String, vault_key_path: String) -> Result<Vec<u8>, CoreError> {
    let key = crypto::vault_key::create_vault_key(password.as_bytes(), Path::new(&vault_key_path))?;
    Ok(key.to_vec())
}

/// Read `vault.key` at `vault_key_path` and unwrap the master key using `password`.
/// A wrong password surfaces as `CoreError::CryptoError`.
fn unlock_vault_key(password: String, vault_key_path: String) -> Result<Vec<u8>, CoreError> {
    let key = crypto::vault_key::unlock_vault_key(password.as_bytes(), Path::new(&vault_key_path))?;
    Ok(key.to_vec())
}

/// Re-wrap the master key under `new_password`. Reads `vault.key`, unwraps with
/// `old_password`, and overwrites it re-wrapped under `new_password`. On-disk
/// secret ciphertext is untouched (only the wrapping key changes). A wrong
/// `old_password` surfaces as `CoreError::CryptoError`.
fn change_vault_password(
    old_password: String,
    new_password: String,
    vault_key_path: String,
) -> Result<(), CoreError> {
    crypto::vault_key::change_password(
        old_password.as_bytes(),
        new_password.as_bytes(),
        Path::new(&vault_key_path),
    )?;
    Ok(())
}

/// Recover a vault using the base64 recovery key (the raw master key) and set
/// `new_password`. `verify_hash` is the `master_key_verify` value from
/// `config.json`; when `Some`, a mismatched recovery key is rejected before any
/// write. When `None` (legacy vaults) any valid 32-byte key is accepted but a
/// one-shot backup of `vault.key` is kept first. Returns the recovered master key.
fn recover_vault_key(
    recovery_key_b64: String,
    new_password: String,
    vault_key_path: String,
    verify_hash: Option<String>,
) -> Result<Vec<u8>, CoreError> {
    let key = crypto::vault_key::recover_with_key(
        &recovery_key_b64,
        new_password.as_bytes(),
        Path::new(&vault_key_path),
        verify_hash.as_deref(),
    )?;
    Ok(key.to_vec())
}

/// Compute the recovery-verification hash for a master key (hex SHA-256, 64 chars).
/// Store this in `config.json` at vault creation so [`recover_vault_key`] can reject
/// wrong recovery keys.
fn compute_master_key_verify(master_key: &[u8]) -> String {
    crypto::vault_key::compute_master_key_verify(master_key)
}

/// Encrypt a git bundle for sync transport under the 32-byte `group_key`. The
/// resulting `CSYNC1` envelope authenticates its header (including the first 8
/// bytes of `device_id`) so the origin cannot be spoofed. Pass an empty
/// `device_id` to omit the origin prefix.
#[cfg(feature = "pro")]
fn encrypt_sync_bundle(
    group_key: &[u8],
    bundle: &[u8],
    bundle_type: BundleType,
    device_id: String,
) -> Result<Vec<u8>, CoreError> {
    let encrypted = sync::encrypt::encrypt_bundle_with_device(
        group_key,
        bundle,
        bundle_type.into(),
        &device_id,
    )?;
    Ok(encrypted)
}

/// Decrypt a `CSYNC1` envelope under `group_key`, returning the plaintext bundle,
/// its type, and the sender's device prefix. Fails with `CoreError::CryptoError`
/// if the key is wrong or the header/ciphertext was tampered with.
#[cfg(feature = "pro")]
fn decrypt_sync_bundle(group_key: &[u8], encrypted: &[u8]) -> Result<DecryptedBundle, CoreError> {
    let device_prefix = sync::encrypt::extract_device_prefix(encrypted);
    let (data, wire_type) = sync::encrypt::decrypt_bundle(group_key, encrypted)?;
    Ok(DecryptedBundle {
        data,
        bundle_type: wire_type.into(),
        device_prefix,
    })
}

/// Apply a decrypted git bundle to the vault repo at `vault_dir` (which must be an
/// existing git repository). Verifies prerequisites, ingests the packfile, and
/// attempts a fast-forward; see [`ApplyResult`] for the divergence/merge outcome.
#[cfg(feature = "pro")]
fn apply_git_bundle(vault_dir: String, bundle_data: &[u8]) -> Result<ApplyResult, CoreError> {
    let result = sync::bundle::apply_bundle(Path::new(&vault_dir), bundle_data)?;
    Ok(ApplyResult {
        commits_applied: result.commits_applied,
        needs_merge: result.needs_merge,
        conflicts: result.conflicts,
    })
}

/// Build a git bundle of commits since `since_oid` (a 40-char hex OID). Pass `None`
/// to include the full history. Returns an empty `Vec` when already up-to-date. The
/// bytes are plaintext — encrypt with [`encrypt_sync_bundle`] before transport.
#[cfg(feature = "pro")]
fn create_incremental_git_bundle(
    vault_dir: String,
    since_oid: Option<String>,
) -> Result<Vec<u8>, CoreError> {
    let oid = since_oid
        .map(|s| git2::Oid::from_str(&s))
        .transpose()
        .map_err(|e| CoreError::GitError(e.to_string()))?;
    let bundle = sync::bundle::create_incremental_bundle(Path::new(&vault_dir), oid)?;
    Ok(bundle)
}

/// Build a full-history git bundle of the whole vault repo at `vault_dir`. Used for
/// the first sync to a device or snapshot recovery. Plaintext — encrypt before
/// transport.
#[cfg(feature = "pro")]
fn create_snapshot_git_bundle(vault_dir: String) -> Result<Vec<u8>, CoreError> {
    let bundle = sync::bundle::create_full_bundle(Path::new(&vault_dir))?;
    Ok(bundle)
}

// The public tree has no sync module. The bindings keep their surface (the
// UDL is one file), and every sync call answers with the same error.
#[cfg(not(feature = "pro"))]
fn sync_unavailable<T>() -> Result<T, CoreError> {
    Err(CoreError::SyncError(
        "sync is not part of this build".to_string(),
    ))
}

#[cfg(not(feature = "pro"))]
fn encrypt_sync_bundle(
    _group_key: &[u8],
    _bundle: &[u8],
    _bundle_type: BundleType,
    _device_id: String,
) -> Result<Vec<u8>, CoreError> {
    sync_unavailable()
}

#[cfg(not(feature = "pro"))]
fn decrypt_sync_bundle(_group_key: &[u8], _encrypted: &[u8]) -> Result<DecryptedBundle, CoreError> {
    sync_unavailable()
}

#[cfg(not(feature = "pro"))]
fn apply_git_bundle(_vault_dir: String, _bundle_data: &[u8]) -> Result<ApplyResult, CoreError> {
    sync_unavailable()
}

#[cfg(not(feature = "pro"))]
fn create_incremental_git_bundle(
    _vault_dir: String,
    _since_oid: Option<String>,
) -> Result<Vec<u8>, CoreError> {
    sync_unavailable()
}

#[cfg(not(feature = "pro"))]
fn create_snapshot_git_bundle(_vault_dir: String) -> Result<Vec<u8>, CoreError> {
    sync_unavailable()
}

/// Stage all changes in the vault repo at `vault_dir` and auto-commit them with a
/// message derived from `message`. The returned [`CommitResult`] has an empty `oid`
/// when there was nothing to commit.
fn commit_vault_changes(vault_dir: String, message: String) -> Result<CommitResult, CoreError> {
    let oid = git::ops::commit_changes(Path::new(&vault_dir), &message)?;
    Ok(CommitResult {
        oid: oid.unwrap_or_default(),
        message,
    })
}

/// Return the current HEAD commit OID (40-char hex) of the vault repo, or `None`
/// for an empty repository with no commits yet.
fn get_head_oid(vault_dir: String) -> Result<Option<String>, CoreError> {
    // The repository's HEAD, or None before the first commit. Read directly
    // so the public build, which has no sync module, answers the same.
    let repo = git2::Repository::open(Path::new(&vault_dir))
        .map_err(|e| CoreError::GitError(e.to_string()))?;
    let oid = match repo.head() {
        Ok(head) => head.target().map(|o| o.to_string()),
        Err(e)
            if e.code() == git2::ErrorCode::UnbornBranch
                || e.code() == git2::ErrorCode::NotFound =>
        {
            None
        }
        Err(e) => return Err(CoreError::GitError(e.to_string())),
    };
    Ok(oid)
}

/// Initialize a new git repository at `vault_dir` (creating the directory if
/// needed). No-op-safe on an already-initialized repo.
fn init_git_repo(vault_dir: String) -> Result<(), CoreError> {
    git2::Repository::init(Path::new(&vault_dir))
        .map_err(|e| CoreError::GitError(e.to_string()))?;
    Ok(())
}

/// Encrypt every plaintext `:::secret[...]` block in `markdown` in place, returning
/// the markdown with each block body replaced by an `enc:v1:` blob. Blocks already
/// encrypted or inside code fences are left untouched.
fn encrypt_page_secrets(master_key: &[u8], markdown: String) -> Result<String, CoreError> {
    let result = pages::secret::encrypt_secrets(&markdown, master_key)?;
    Ok(result)
}

/// Decrypt every `enc:v1:` secret block in `markdown` back to plaintext. Blocks
/// that are already plaintext or inside code fences are left untouched.
fn decrypt_page_secrets(master_key: &[u8], markdown: String) -> Result<String, CoreError> {
    let result = pages::secret::decrypt_secrets(&markdown, master_key)?;
    Ok(result)
}

/// Encrypt an entire page body as one `enc:v1:` blob (used for fully-encrypted
/// pages rather than per-block secrets).
fn encrypt_full_body(master_key: &[u8], content: String) -> Result<String, CoreError> {
    let result = pages::secret::encrypt_full_body(&content, master_key)?;
    Ok(result)
}

/// Decrypt a full-body `enc:v1:` page produced by [`encrypt_full_body`]. Fails with
/// `CoreError::CryptoError` if `content` is not full-body encrypted.
fn decrypt_full_body(master_key: &[u8], content: String) -> Result<String, CoreError> {
    let result = pages::secret::decrypt_full_body(&content, master_key)?;
    Ok(result)
}

/// Return `true` if `content` contains at least one real `:::secret[...]` block
/// (ignoring occurrences inside fenced code blocks). No key required.
fn has_secret_blocks(content: String) -> bool {
    pages::secret::has_secret_blocks(&content)
}

/// Extract the plaintext labels of all secret blocks in `content`, in document
/// order, for search indexing. Labels are readable regardless of encryption state.
fn extract_secret_labels(content: String) -> Vec<String> {
    pages::secret::extract_secret_labels(&content)
}

fn get_file_log(
    vault_dir: String,
    rel_path: String,
    max_count: u32,
) -> Result<Vec<GitCommitEntry>, CoreError> {
    let entries = git::ops::get_file_log(Path::new(&vault_dir), &rel_path, max_count as usize)?;
    Ok(entries
        .into_iter()
        .map(|e| GitCommitEntry {
            oid: e.oid,
            message: e.message,
            timestamp_secs: e.timestamp.timestamp(),
        })
        .collect())
}

fn get_file_at_commit(
    vault_dir: String,
    oid: String,
    rel_path: String,
) -> Result<Option<String>, CoreError> {
    let content = git::ops::get_file_at_commit(Path::new(&vault_dir), &oid, &rel_path)?;
    Ok(content)
}

fn get_commit_diff(
    vault_dir: String,
    oid: String,
    rel_path: String,
) -> Result<GitCommitDiff, CoreError> {
    let diff = git::ops::get_commit_diff(Path::new(&vault_dir), &oid, &rel_path)?;
    Ok(GitCommitDiff {
        oid: diff.oid,
        message: diff.message,
        timestamp_secs: diff.timestamp.timestamp(),
        parent_content: diff.parent_content,
        current_content: diff.current_content,
    })
}
