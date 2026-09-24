// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! OS keychain storage for the secrets that back biometric unlock.
//!
//! Wraps the cross-platform `keyring` crate to persist two base64-encoded
//! secrets per vault: the vault `master-key` and the sync `group-key`. Storing
//! both lets a biometric unlock reconstruct the exact same in-memory state a
//! password unlock would (the group key is `kdf(password, vault_id)` and cannot
//! be derived from the master key alone). Retrieved keys are wrapped in
//! `Zeroizing` so they are wiped on drop.
//!
//! **Entries are scoped by `vault_id`**, matching
//! [`crate::vault::token_store`]. They were not always: until 3.3.34 both keys
//! lived at the fixed accounts `master-key` and `group-key`, with nothing
//! naming the vault. Anyone running two vaults on one machine — a work vault
//! and a personal one, or a second machine's vault restored alongside — had
//! the second enrolment silently overwrite the first, after which the first
//! vault's biometric unlock returned another vault's master key and every
//! secret failed to decrypt with no indication why.
//!
//! [`adopt_legacy_entries`] migrates an unscoped entry, but only after proving
//! the key belongs to the vault asking for it. See its documentation.
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

/// The accounts used before entries were scoped by vault. Read by
/// [`adopt_legacy_entries`] and never written.
const LEGACY_MASTER_KEY_USER: &str = "master-key";
const LEGACY_GROUP_KEY_USER: &str = "group-key";

fn master_key_account(vault_id: &str) -> String {
    format!("master-key.{vault_id}")
}

fn group_key_account(vault_id: &str) -> String {
    format!("group-key.{vault_id}")
}

fn entry(account: &str) -> Result<Entry, BiometricError> {
    Entry::new(SERVICE, account).map_err(|e| BiometricError::KeychainError(e.to_string()))
}

/// Read a base64-encoded secret, mapping "no such entry" to `Ok(None)`.
fn read(account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, BiometricError> {
    let encoded = match entry(account)?.get_password() {
        Ok(v) => v,
        Err(keyring::Error::NoEntry) => return Ok(None),
        Err(e) => return Err(BiometricError::KeychainError(e.to_string())),
    };
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|e| BiometricError::KeychainError(format!("base64 decode: {e}")))?;
    Ok(Some(Zeroizing::new(bytes)))
}

/// Delete an entry, treating "already gone" as success.
fn delete(account: &str) -> Result<(), BiometricError> {
    match entry(account)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(BiometricError::KeychainError(e.to_string())),
    }
}

/// Store the master key for `vault_id` in the platform keychain (base64-encoded).
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
pub fn store_master_key(vault_id: &str, key: &[u8]) -> Result<(), BiometricError> {
    let encoded = STANDARD.encode(key);
    entry(&master_key_account(vault_id))?
        .set_password(&encoded)
        .map_err(|e| BiometricError::KeychainError(e.to_string()))
}

/// Retrieve the master key for `vault_id` from the platform keychain.
/// Returns `Zeroizing<Vec<u8>>` so the key is automatically zeroed on drop/error paths.
pub fn retrieve_master_key(vault_id: &str) -> Result<Zeroizing<Vec<u8>>, BiometricError> {
    read(&master_key_account(vault_id))?.ok_or(BiometricError::NoCredential)
}

/// Remove the master key for `vault_id` from the platform keychain.
pub fn delete_master_key(vault_id: &str) -> Result<(), BiometricError> {
    delete(&master_key_account(vault_id))
}

/// Check whether a stored key exists for `vault_id` without retrieving it.
pub fn has_stored_key(vault_id: &str) -> Result<bool, BiometricError> {
    Ok(read(&master_key_account(vault_id))?.is_some())
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

/// Store the sync group key for `vault_id` in the platform keychain.
pub fn store_group_key(vault_id: &str, key: &[u8]) -> Result<(), BiometricError> {
    let encoded = STANDARD.encode(key);
    entry(&group_key_account(vault_id))?
        .set_password(&encoded)
        .map_err(|e| BiometricError::KeychainError(e.to_string()))
}

/// Retrieve the sync group key for `vault_id`. Returns `Ok(None)` if none was
/// stored (e.g. biometric was enrolled before this split was introduced —
/// caller can re-derive from the password on next unlock).
pub fn retrieve_group_key(vault_id: &str) -> Result<Option<Zeroizing<Vec<u8>>>, BiometricError> {
    read(&group_key_account(vault_id))
}

/// Remove the group key entry for `vault_id`. Called alongside
/// [`delete_master_key`] when biometric is disabled.
pub fn delete_group_key(vault_id: &str) -> Result<(), BiometricError> {
    delete(&group_key_account(vault_id))
}

// ─── device signing key ───────────────────────────────────────────────────
//
// The Ed25519 key a sync device signs its requests with, PKCS#8, keyed by
// the device id because it is the device's identity: a second vault on the
// same machine registers as its own device with its own key.

// Only sync signs requests with a device key, and sync is not in the public build.
#[cfg(feature = "pro")]
fn device_key_account(device_id: &str) -> String {
    format!("device-key.{device_id}")
}

#[cfg(feature = "pro")]
/// Store the sync device key for `device_id` in the platform keychain.
pub fn store_device_key(device_id: &str, key: &[u8]) -> Result<(), BiometricError> {
    let encoded = STANDARD.encode(key);
    entry(&device_key_account(device_id))?
        .set_password(&encoded)
        .map_err(|e| BiometricError::KeychainError(e.to_string()))
}

#[cfg(feature = "pro")]
/// Retrieve the sync device key for `device_id`; `Ok(None)` when the device
/// registered before keys existed.
pub fn retrieve_device_key(device_id: &str) -> Result<Option<Zeroizing<Vec<u8>>>, BiometricError> {
    read(&device_key_account(device_id))
}

#[cfg(feature = "pro")]
/// Remove the device key; called when sync is disabled on this device.
pub fn delete_device_key(device_id: &str) -> Result<(), BiometricError> {
    delete(&device_key_account(device_id))
}

// ─── migration from the unscoped entries ─────────────────────────────────

/// Whether an unscoped keychain entry holds `vault`'s master key.
///
/// `verify_hash` is the vault's `master_key_verify` from `config.json`. Absent,
/// the answer is no: an unprovable entry is treated as another vault's, which
/// costs one re-enrolment and never hands a vault the wrong key.
fn legacy_entry_belongs_to(verify_hash: Option<&str>, legacy_master_key: &[u8]) -> bool {
    let Some(expected) = verify_hash else {
        return false;
    };
    let actual = claspt_core::crypto::vault_key::compute_master_key_verify(legacy_master_key);
    claspt_core::crypto::compare::constant_time_eq(actual.as_bytes(), expected.as_bytes())
}

/// Adopt a pre-3.3.34 unscoped entry for `vault_id`, if and only if the key it
/// holds belongs to this vault.
///
/// Ownership is proved against `verify_hash`, the vault's
/// `master_key_verify` from `config.json`, which is
/// `SHA-256(master_key || "claspt-verify")`. A machine with two enrolled
/// vaults has one unscoped entry holding one of the two master keys; without
/// this check the other vault would adopt a key that cannot decrypt anything
/// it owns, turning a recoverable "biometric is not set up" into a vault whose
/// every secret appears corrupt.
///
/// Fails closed. A vault with no `master_key_verify` (written at creation
/// since 2.x, and backfilled on password unlock) cannot prove ownership, so
/// nothing is adopted and the user is asked to enrol again — one Touch ID
/// prompt, rather than a silent mis-unlock.
///
/// Returns whether an entry was adopted. The legacy entries are removed only
/// once the scoped ones are written.
pub fn adopt_legacy_entries(
    vault_id: &str,
    verify_hash: Option<&str>,
) -> Result<bool, BiometricError> {
    // Already scoped: nothing to do. Checked first so the common path costs
    // one keychain read rather than two.
    if has_stored_key(vault_id)? {
        return Ok(false);
    }

    let Some(legacy_master) = read(LEGACY_MASTER_KEY_USER)? else {
        return Ok(false);
    };
    if !legacy_entry_belongs_to(verify_hash, &legacy_master) {
        // No proof, or proof that it is another vault's. Leave it alone: it is
        // that vault's only enrolment.
        return Ok(false);
    }

    store_master_key(vault_id, &legacy_master)?;
    if let Some(legacy_group) = read(LEGACY_GROUP_KEY_USER)? {
        store_group_key(vault_id, &legacy_group)?;
    }

    // Only now that the scoped entries exist is it safe to drop the originals.
    delete(LEGACY_MASTER_KEY_USER)?;
    delete(LEGACY_GROUP_KEY_USER)?;
    Ok(true)
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accounts_are_scoped_per_vault_and_per_key() {
        // The bug this scoping fixes: two vaults on one machine shared one
        // account name, so the second enrolment overwrote the first and the
        // first vault then unlocked with another vault's master key.
        assert_ne!(master_key_account("vault-a"), master_key_account("vault-b"));
        assert_ne!(group_key_account("vault-a"), group_key_account("vault-b"));
        assert_ne!(master_key_account("vault-a"), group_key_account("vault-a"));
    }

    #[test]
    fn account_names_are_stable() {
        // These strings name entries in the user's keychain. Changing one
        // orphans the entry it used to name, which silently turns biometric
        // unlock off, so this test exists to make such a change deliberate.
        assert_eq!(master_key_account("abc-123"), "master-key.abc-123");
        assert_eq!(group_key_account("abc-123"), "group-key.abc-123");
    }

    #[test]
    fn scoped_accounts_never_collide_with_the_legacy_ones() {
        // A scoped name that could equal an unscoped one would make the
        // migration delete the entry it had just written.
        assert_ne!(master_key_account(""), LEGACY_MASTER_KEY_USER);
        assert_ne!(group_key_account(""), LEGACY_GROUP_KEY_USER);
    }

    #[test]
    fn a_legacy_entry_is_adopted_only_by_the_vault_whose_key_it_holds() {
        let ours = [7u8; 32];
        let theirs = [9u8; 32];
        let our_hash = claspt_core::crypto::vault_key::compute_master_key_verify(&ours);

        assert!(
            legacy_entry_belongs_to(Some(&our_hash), &ours),
            "a vault must adopt its own key"
        );
        assert!(
            !legacy_entry_belongs_to(Some(&our_hash), &theirs),
            "adopting another vault's key would make every secret fail to decrypt"
        );
    }

    #[test]
    fn a_vault_that_cannot_prove_ownership_adopts_nothing() {
        // Fail closed. A vault predating master_key_verify has no proof, and
        // guessing would hand it a key that decrypts none of its own secrets.
        // One extra enrolment is the correct price.
        assert!(!legacy_entry_belongs_to(None, &[7u8; 32]));
    }
}
