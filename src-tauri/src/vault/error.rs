// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Error type for vault operations.
//!
//! [`VaultError`] is the unified error returned by vault creation, unlock, config, and
//! help-page code. It wraps lower-level errors (crypto, git2, I/O, JSON) via `#[from]` so `?`
//! propagates cleanly, and its custom [`serde::Serialize`] impl renders the `Display` string so
//! the error can cross the Tauri IPC boundary as a plain human-readable message for the frontend.

use thiserror::Error;

use crate::crypto::error::CryptoError;

/// Errors produced by vault initialization, authentication, and configuration.
#[derive(Debug, Error)]
pub enum VaultError {
    #[error("vault already exists at {0}")]
    AlreadyExists(String),

    #[error("vault not found at {0}")]
    NotFound(String),

    #[error("password too short: minimum 12 characters required")]
    PasswordTooShort,

    #[error("incorrect password")]
    WrongPassword,

    #[error("too many failed attempts — wait {0} seconds")]
    BruteForceDelay(u64),

    #[error("invalid config: {0}")]
    InvalidConfig(String),

    #[error("crypto error: {0}")]
    Crypto(#[from] CryptoError),

    #[error("git error: {0}")]
    Git(#[from] git2::Error),

    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("internal lock error")]
    LockPoisoned,
}

impl serde::Serialize for VaultError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
