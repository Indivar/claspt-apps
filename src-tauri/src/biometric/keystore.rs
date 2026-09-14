// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! OS keychain storage for the secrets that back biometric unlock.
//!
//! Wraps the cross-platform `keyring` crate to persist two base64-encoded
//! secrets under the app's service name: the vault `master-key` and the sync
//! `group-key`. Storing both lets a biometric unlock reconstruct the exact same
//! in-memory state a password unlock would (the group key is
//! `kdf(password, vault_id)` and cannot be derived from the master key alone).
//! Retrieved keys are wrapped in `Zeroizing` so they are wiped on drop.
//!
//! Known limitation (documented on [`store_master_key`]): the generic keyring
//! item is not bound to a Secure-Enclave/Hello access-control policy, so
//! biometric proof is verified in-process rather than gating key retrieval at
//! the OS level.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use keyring::Entry;
use zeroize::Zeroizing;

use super::error::BiometricError;

const SERVICE: &str = "in.indivar.claspt";
const USER: &str = "master-key";
const GROUP_KEY_USER: &str = "group-key";

fn entry() -> Result<Entry, BiometricError> {
    Entry::new(SERVICE, USER).map_err(|e| BiometricError::KeychainError(e.to_string()))
}

fn group_key_entry() -> Result<Entry, BiometricError> {
    Entry::new(SERVICE, GROUP_KEY_USER).map_err(|e| BiometricError::KeychainError(e.to_string()))
}

/// Store the master key in the platform keychain (base64-encoded).
///
/// SECURITY / KNOWN LIMITATION: the generic `keyring` crate stores this item
/// with the platform default accessibility (login-keychain-unlocked on macOS),
/// NOT bound to a biometric/Secure-Enclave access-control policy. Biometric
/// proof is currently verified in-process and is logically separate from key
/// retrieval, so a process running as the same user can read the key without
/// Touch ID/Windows Hello firing. Hardening this requires platform-specific
/// code — on macOS a `SecAccessControl` item (`biometryCurrentSet` +
/// `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`) via `security-framework`,
/// on Windows a Hello/DPAPI-gated store — and MUST be validated on real
/// hardware (Touch ID prompts cannot be exercised in CI).
pub fn store_master_key(key: &[u8]) -> Result<(), BiometricError> {
    let encoded = STANDARD.encode(key);
    entry()?
        .set_password(&encoded)
        .map_err(|e| BiometricError::KeychainError(e.to_string()))
}

/// Retrieve the master key from the platform keychain.
/// Returns `Zeroizing<Vec<u8>>` so the key is automatically zeroed on drop/error paths.
pub fn retrieve_master_key() -> Result<Zeroizing<Vec<u8>>, BiometricError> {
    let encoded = entry()?.get_password().map_err(|e| match e {
        keyring::Error::NoEntry => BiometricError::NoCredential,
        other => BiometricError::KeychainError(other.to_string()),
    })?;
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|e| BiometricError::KeychainError(format!("base64 decode: {e}")))?;
    Ok(Zeroizing::new(bytes))
}

/// Remove the master key from the platform keychain.
pub fn delete_master_key() -> Result<(), BiometricError> {
    entry()?.delete_credential().map_err(|e| match e {
        keyring::Error::NoEntry => BiometricError::NoCredential,
        other => BiometricError::KeychainError(other.to_string()),
    })
}

/// Check whether a stored key exists without retrieving it.
#[allow(dead_code)]
pub fn has_stored_key() -> Result<bool, BiometricError> {
    match entry()?.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(BiometricError::KeychainError(e.to_string())),
    }
}

// ─── group_key ───────────────────────────────────────────────────────────
//
// Stored alongside the master key so biometric unlock can restore BOTH.
// Historically only the master key was stored, and biometric unlock left
// `VaultState.group_key = None`. The sync engine's legacy fallback path
// then used the master key as a substitute for the group key when pushing
// bundles — but the master key is unrelated to `kdf(password, vault_id)`
// and other devices deriving the real group key from the same password
// can't decrypt. This split-key storage fixes that class of bug: biometric
// and password unlock now produce an identical in-memory state.

/// Store the sync group key in the platform keychain (base64-encoded).
pub fn store_group_key(key: &[u8]) -> Result<(), BiometricError> {
    let encoded = STANDARD.encode(key);
    group_key_entry()?
        .set_password(&encoded)
        .map_err(|e| BiometricError::KeychainError(e.to_string()))
}

/// Retrieve the sync group key from the platform keychain. Returns `Ok(None)`
/// if no group key was stored (e.g. biometric was enrolled before this split
/// was introduced — caller can re-derive from the password on next unlock).
pub fn retrieve_group_key() -> Result<Option<Zeroizing<Vec<u8>>>, BiometricError> {
    let encoded = match group_key_entry()?.get_password() {
        Ok(v) => v,
        Err(keyring::Error::NoEntry) => return Ok(None),
        Err(e) => return Err(BiometricError::KeychainError(e.to_string())),
    };
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|e| BiometricError::KeychainError(format!("base64 decode: {e}")))?;
    Ok(Some(Zeroizing::new(bytes)))
}

/// Remove the group key entry. Called alongside `delete_master_key` when
/// biometric is disabled.
pub fn delete_group_key() -> Result<(), BiometricError> {
    match group_key_entry()?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()), // idempotent
        Err(e) => Err(BiometricError::KeychainError(e.to_string())),
    }
}
