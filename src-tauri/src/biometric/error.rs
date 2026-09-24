// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Error type for the biometric/keychain subsystem.
//!
//! Serializes to its display string so the frontend can show the reason a
//! biometric unlock failed or was refused.

use thiserror::Error;

/// Failure modes for biometric authentication and keychain access.
#[derive(Debug, Error)]
pub enum BiometricError {
    /// No biometric API is available (Linux, unsupported platforms, or no
    /// enrolled biometrics).
    #[error("biometric not available on this platform")]
    #[allow(dead_code)] // used on Linux and fallback platforms
    NotAvailable,

    /// The OS biometric prompt failed or the user cancelled/was rejected.
    #[error("biometric authentication failed: {0}")]
    AuthFailed(String),

    /// Reading from or writing to the OS keychain failed.
    #[error("keychain error: {0}")]
    KeychainError(String),

    /// No secret has been stored in the keychain for this vault yet.
    #[error("no stored credential found")]
    NoCredential,

    /// The key the keychain released did not match the vault it was asked
    /// to open, so biometric unlock was switched off for that vault.
    #[error(
        "The biometric key saved on this device did not match this vault, so biometric unlock was switched off. Unlock with your password, then turn it back on in Settings › Security."
    )]
    WrongVault,

    /// Biometric unlock is temporarily locked out after repeated failures;
    /// the payload is the remaining cooldown in seconds.
    #[error("too many failed attempts — wait {0} seconds")]
    BruteForceDelay(u64),

    /// An unrecognized biometric mode string was supplied.
    #[error("invalid biometric mode: {0}")]
    InvalidMode(String),
}

impl serde::Serialize for BiometricError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
