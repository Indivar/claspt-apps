// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Error type for the git subsystem.
//!
//! [`GitError`] serializes to its human-readable message string so it can cross the Tauri
//! IPC boundary and surface directly in the frontend.
use thiserror::Error;

/// Errors that can arise while committing, reading history, or restoring vault files.
#[derive(Debug, Error)]
pub enum GitError {
    /// An underlying `git2` operation failed (open repo, stage, commit, walk, etc.).
    #[error("git error: {0}")]
    Git(#[from] git2::Error),

    /// A git operation was requested but no vault directory has been set.
    #[error("vault not open")]
    VaultNotOpen,

    /// A non-git failure with a descriptive message (e.g. invalid OID, UTF-8 decode,
    /// or a filesystem write while restoring a file).
    #[error("{0}")]
    Other(String),

    /// A `Mutex` guarding batch-commit state was poisoned by a panic in another thread.
    #[error("internal lock error")]
    LockPoisoned,
}

impl serde::Serialize for GitError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
