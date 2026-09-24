// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! One key wrapped under another, for restoring a vault on a second device.
//!
//! Two wrappings make restore possible without any key reaching the server
//! in the clear:
//!
//! - the master key wrapped under the sync group key, kept in the vault's
//!   own history (`.claspt/master-key.wrapped`), so a device that knows the
//!   master password, and so the group key, can install the master key
//!   after its first pull;
//! - the group key wrapped under the master key, kept by the server for the
//!   group, so a device that has the recovery key (the master key itself,
//!   base64) but not the password can obtain the group key, pull, and set
//!   a new password.
//!
//! Both are AES-256-GCM with a magic prefix bound as associated data, the
//! same construction as sealed attachments.

use zeroize::Zeroizing;

use super::aead;
use super::error::CryptoError;

/// The first bytes of a wrapped key; also the AEAD associated data.
pub const MAGIC: &[u8; 20] = b"CLASPT-WRAPPED-KEY-1";

/// Wrap `key` under `kek`.
pub fn wrap(kek: &[u8], key: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let nonce = aead::generate_nonce()?;
    let sealed = aead::seal_with_nonce_aad(kek, nonce, MAGIC, key)?;
    let mut out = Vec::with_capacity(MAGIC.len() + aead::NONCE_LEN + sealed.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&sealed);
    Ok(out)
}

/// Unwrap a key wrapped by [`wrap`] under `kek`. Key material, so zeroed on drop.
pub fn unwrap(kek: &[u8], wrapped: &[u8]) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    let body = wrapped
        .strip_prefix(MAGIC)
        .ok_or_else(|| CryptoError::InvalidVaultKey("not a wrapped key".into()))?;
    if body.len() < aead::NONCE_LEN {
        return Err(CryptoError::Decryption);
    }
    let (nonce_bytes, ciphertext_and_tag) = body.split_at(aead::NONCE_LEN);
    let mut nonce = [0u8; aead::NONCE_LEN];
    nonce.copy_from_slice(nonce_bytes);
    aead::open_with_nonce_aad(kek, nonce, MAGIC, ciphertext_and_tag)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_wrapped_key_comes_back_only_under_the_same_kek() {
        let kek = [7u8; 32];
        let key = [9u8; 32];
        let wrapped = wrap(&kek, &key).unwrap();
        assert!(wrapped.starts_with(MAGIC));
        assert_eq!(unwrap(&kek, &wrapped).unwrap().as_slice(), &key);
        assert!(unwrap(&[8u8; 32], &wrapped).is_err());
        let mut tampered = wrapped.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 1;
        assert!(unwrap(&kek, &tampered).is_err());
        assert!(unwrap(&kek, b"CLASPT-SEALED-1\nnope").is_err());
    }

    #[test]
    fn each_wrap_is_fresh() {
        let kek = [1u8; 32];
        assert_ne!(
            wrap(&kek, &[2u8; 32]).unwrap(),
            wrap(&kek, &[2u8; 32]).unwrap()
        );
    }
}
