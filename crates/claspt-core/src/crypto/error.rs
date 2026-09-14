// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Error type for the crypto module. Decryption failures are intentionally
//! coarse — a wrong password and corrupted ciphertext both surface as
//! [`CryptoError::Decryption`] with no distinguishing detail, so an attacker
//! cannot use the error to tell which one occurred.
use thiserror::Error;

/// Failure modes of the crypto primitives (KDF, AEAD, and `vault.key` handling).
#[derive(Debug, Error)]
pub enum CryptoError {
    /// Argon2id key derivation failed (e.g. invalid parameters).
    #[error("key derivation failed: {0}")]
    KeyDerivation(String),

    /// AES-256-GCM sealing or key/nonce setup failed.
    #[error("encryption failed: {0}")]
    Encryption(String),

    /// GCM authentication failed — deliberately opaque: a wrong password and
    /// tampered/corrupted ciphertext are indistinguishable here.
    #[error("decryption failed — wrong password or corrupted data")]
    Decryption,

    /// The `vault.key` file was malformed, too short, or an unsupported version.
    #[error("invalid vault key file: {0}")]
    InvalidVaultKey(String),

    /// An underlying filesystem read/write failed.
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    /// A base64-encoded input (e.g. a secret block or recovery key) failed to decode.
    #[error("base64 decode error: {0}")]
    Base64(#[from] base64::DecodeError),
}

// Tauri commands need serde::Serialize on errors
impl serde::Serialize for CryptoError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
