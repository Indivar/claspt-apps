// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Tauri IPC commands for the vault's built-in Git version history.
//!
//! The vault directory is a Git repository that Claspt auto-commits to. Page saves are
//! coalesced through a `BatchCommitter` (a 5s debounce window) rather than committing on
//! every keystroke; the commands here expose the resulting history to the frontend:
//! listing commits, viewing a page at a past commit, diffing, and restoring. Read/query
//! commands require a vault to be open and surface `GitError` on failure.
use tauri::State;

use super::crypto::VaultState;
use crate::git::batch::BatchCommitter;
use crate::git::error::GitError;
use crate::git::ops::{self, CommitDiff, CommitEntry};

/// Holds the batch committer in Tauri managed state.
pub struct GitState {
    pub batcher: BatchCommitter,
}

impl GitState {
    pub fn new() -> Self {
        Self {
            batcher: BatchCommitter::new(),
        }
    }
}

fn get_vault_dir(state: &State<VaultState>) -> Result<std::path::PathBuf, GitError> {
    state.vault_dir().ok_or(GitError::VaultNotOpen)
}

/// Record a page save for batched git commit.
/// Called automatically after page create/update.
pub fn record_save_if_active(title: &str, git_state: &State<GitState>) {
    let _ = git_state.batcher.record_save(title);
}

/// Initialize git state when vault is opened.
pub fn init_git_state(vault_dir: &std::path::Path, git_state: &GitState) {
    git_state.batcher.set_vault_dir(vault_dir);
}

/// Clear git state when vault is locked.
pub fn close_git_state(git_state: &GitState) {
    git_state.batcher.clear();
}

/// Force commit all pending changes.
#[tauri::command]
pub fn git_commit(
    vault_state: State<VaultState>,
    git_state: State<GitState>,
) -> Result<Option<String>, GitError> {
    let _vault_dir = get_vault_dir(&vault_state)?;
    git_state.batcher.flush()
}

/// Get commit history for the vault.
#[tauri::command]
pub fn git_log(
    max_count: Option<usize>,
    vault_state: State<VaultState>,
) -> Result<Vec<CommitEntry>, GitError> {
    let vault_dir = get_vault_dir(&vault_state)?;
    ops::get_log(&vault_dir, max_count.unwrap_or(50))
}

/// Get commit history for a specific page.
#[tauri::command]
pub fn git_file_log(
    path: String,
    max_count: Option<usize>,
    vault_state: State<VaultState>,
) -> Result<Vec<CommitEntry>, GitError> {
    let vault_dir = get_vault_dir(&vault_state)?;
    ops::get_file_log(&vault_dir, &path, max_count.unwrap_or(50))
}

/// Get the content of a file at a specific commit.
#[tauri::command]
pub fn git_file_at_commit(
    oid: String,
    path: String,
    vault_state: State<VaultState>,
) -> Result<Option<String>, GitError> {
    let vault_dir = get_vault_dir(&vault_state)?;
    ops::get_file_at_commit(&vault_dir, &oid, &path)
}

/// Get the diff of a file between a commit and its parent.
#[tauri::command]
pub fn git_commit_diff(
    oid: String,
    path: String,
    vault_state: State<VaultState>,
) -> Result<CommitDiff, GitError> {
    let vault_dir = get_vault_dir(&vault_state)?;
    ops::get_commit_diff(&vault_dir, &oid, &path)
}

/// Restore a file to its state at a specific commit.
/// Creates a new commit recording the restore action.
#[tauri::command]
pub fn git_restore_to_commit(
    oid: String,
    path: String,
    vault_state: State<VaultState>,
) -> Result<String, GitError> {
    let vault_dir = get_vault_dir(&vault_state)?;
    ops::restore_file_to_commit(&vault_dir, &oid, &path)
}
