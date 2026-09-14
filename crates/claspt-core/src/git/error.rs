// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Error type for git operations over the vault repository.
use thiserror::Error;

/// Failure modes of the vault git operations.
#[derive(Debug, Error)]
pub enum GitError {
    /// An underlying `git2` operation failed.
    #[error("git error: {0}")]
    Git(#[from] git2::Error),

    /// A git operation was attempted with no vault repository open.
    #[error("vault not open")]
    VaultNotOpen,

    /// Any other git failure (invalid OID, non-UTF-8 blob, write failure, etc.).
    #[error("{0}")]
    Other(String),

    /// An internal mutex guarding the repo was poisoned by a panicking thread.
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
