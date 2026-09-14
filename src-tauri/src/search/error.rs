// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Error type for the search subsystem.
//!
//! [`SearchError`] serializes to its human-readable message string so it can cross the
//! Tauri IPC boundary and surface directly in the frontend.
use thiserror::Error;

/// Errors that can arise while opening, updating, or querying the search index.
#[derive(Debug, Error)]
pub enum SearchError {
    /// A tantivy index operation failed (open, create, add, commit, reload, or search).
    /// The wrapped string carries the underlying tantivy error message.
    #[error("index error: {0}")]
    Index(String),

    /// The user's query string could not be parsed by tantivy's query parser.
    #[error("query parse error: {0}")]
    QueryParse(String),

    /// A filesystem error occurred, e.g. creating the index directory.
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    /// A search was requested but no vault is currently open.
    #[error("vault not open")]
    VaultNotOpen,

    /// A `Mutex` guarding shared search state was poisoned by a panic in another thread.
    #[error("internal lock error")]
    LockPoisoned,
}

impl serde::Serialize for SearchError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
