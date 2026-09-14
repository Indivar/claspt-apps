// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Deterministic sync group key. [`derive_group_key`] stretches the password
//! with a salt bound to the vault via `SHA-256("claspt-sync-group:{vault_id}")`,
//! producing a 256-bit key used only to encrypt sync bundles in transit. Key
//! invariant: because the salt is derived from `vault_id`, two vaults sharing
//! the same password still get distinct group keys, and this key is deliberately
//! separate from the master key so the sync server never sees anything derived
//! from the key that guards on-disk secrets.
use ring::digest::{digest, SHA256};
use zeroize::Zeroizing;

use super::error::CryptoError;
use super::kdf;

/// Derive a 256-bit group key for sync encryption.
///
/// The salt is derived from `SHA-256("claspt-sync-group:{vault_id}")[..16]`,
/// ensuring each vault produces a unique sync key even with the same password.
#[allow(dead_code)]
pub fn derive_group_key(
    password: &[u8],
    vault_id: &str,
) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    let salt_input = format!("claspt-sync-group:{vault_id}");
    let hash = digest(&SHA256, salt_input.as_bytes());
    let salt = &hash.as_ref()[..16];
    kdf::derive_key(password, salt)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_inputs_same_output() {
        let key1 = derive_group_key(b"test-password-12chars", "vault-abc-123").unwrap();
        let key2 = derive_group_key(b"test-password-12chars", "vault-abc-123").unwrap();
        assert_eq!(key1, key2);
        assert_eq!(key1.len(), 32);
    }

    #[test]
    fn different_vault_id_different_key() {
        let key1 = derive_group_key(b"test-password-12chars", "vault-aaa").unwrap();
        let key2 = derive_group_key(b"test-password-12chars", "vault-bbb").unwrap();
        assert_ne!(key1, key2);
    }

    #[test]
    fn different_password_different_key() {
        let key1 = derive_group_key(b"password-alpha-12", "vault-same").unwrap();
        let key2 = derive_group_key(b"password-bravo-12", "vault-same").unwrap();
        assert_ne!(key1, key2);
    }

    #[test]
    fn roundtrip_with_encrypt_decrypt() {
        use super::super::aead;
        let key = derive_group_key(b"roundtrip-test-pass", "vault-rt").unwrap();
        let plaintext = b"secret sync data";
        let encrypted = aead::encrypt(&key, plaintext).unwrap();
        let decrypted = aead::decrypt(&key, &encrypted).unwrap();
        assert_eq!(&*decrypted, plaintext);
    }
}
