// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Sealed attachments: a file in a folder's `_media/` directory encrypted
//! under the vault's master key.
//!
//! The choice is per file and the user's. A plain attachment is the bytes as
//! they were given, readable from the vault folder in Finder; a sealed one
//! opens only inside Claspt. Both keep the same file name and the same
//! markdown reference, so sealing after the fact and removing the seal never
//! touch the page that refers to the file.
//!
//! On-disk shape: [`MAGIC`] followed by the master-key AEAD of the original
//! bytes (`nonce || ciphertext || tag`, the same construction a secret block
//! uses). The magic is bound as associated data, so a sealed file cannot be
//! passed off as something else without the tag failing. Every reader first
//! asks [`is_sealed`]; a plain file never starts with the magic because no
//! allowed attachment type begins with those bytes.

use zeroize::Zeroizing;

use super::aead;
use super::error::CryptoError;

/// The bytes every sealed attachment starts with.
pub const MAGIC: &[u8; 16] = b"CLASPT-SEALED-1\n";

/// Bytes a sealed file carries beyond its plaintext: the magic, the nonce
/// and the AEAD tag. The original size of a sealed file is its size on disk
/// minus this, so a listing can state it without opening the file.
pub const OVERHEAD: usize = MAGIC.len() + aead::NONCE_LEN + aead::TAG_LEN;

/// Whether `bytes` are a sealed attachment.
pub fn is_sealed(bytes: &[u8]) -> bool {
    bytes.starts_with(MAGIC)
}

/// Seal `plaintext` under `master_key`.
pub fn seal(master_key: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let nonce = aead::generate_nonce()?;
    let sealed = aead::seal_with_nonce_aad(master_key, nonce, MAGIC, plaintext)?;
    let mut out = Vec::with_capacity(MAGIC.len() + aead::NONCE_LEN + sealed.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&sealed);
    Ok(out)
}

/// Open a sealed attachment under `master_key`, returning the original bytes.
///
/// The bytes are the user's own content on their way to the screen, not key
/// material, so they are returned as a plain `Vec` (see ADR 0002).
pub fn open(master_key: &[u8], sealed: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let body = sealed
        .strip_prefix(MAGIC)
        .ok_or_else(|| CryptoError::InvalidVaultKey("not a sealed attachment".into()))?;
    if body.len() < aead::NONCE_LEN {
        return Err(CryptoError::Decryption);
    }
    let (nonce_bytes, ciphertext_and_tag) = body.split_at(aead::NONCE_LEN);
    let mut nonce = [0u8; aead::NONCE_LEN];
    nonce.copy_from_slice(nonce_bytes);
    let plain: Zeroizing<Vec<u8>> =
        aead::open_with_nonce_aad(master_key, nonce, MAGIC, ciphertext_and_tag)?;
    Ok(plain.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: [u8; 32] = [4u8; 32];

    #[test]
    fn seal_and_open_round_trip_and_keep_the_bytes_exact() {
        let png = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR-not-really-an-image".to_vec();
        let sealed = seal(&KEY, &png).unwrap();
        assert!(is_sealed(&sealed));
        assert!(!is_sealed(&png));
        assert_ne!(
            &sealed[MAGIC.len()..],
            &png[..],
            "sealed bytes must not carry the plaintext"
        );
        assert_eq!(open(&KEY, &sealed).unwrap(), png);
    }

    #[test]
    fn a_wrong_key_or_a_changed_byte_is_refused() {
        let sealed = seal(&KEY, b"hello").unwrap();
        assert!(open(&[5u8; 32], &sealed).is_err());
        let mut tampered = sealed.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 1;
        assert!(open(&KEY, &tampered).is_err());
        // The magic is bound as associated data: swapping it in breaks the tag.
        let mut relabelled = sealed.clone();
        relabelled[0] ^= 1;
        assert!(!is_sealed(&relabelled));
        assert!(open(&KEY, &relabelled).is_err());
    }

    #[test]
    fn plain_bytes_are_not_opened() {
        assert!(open(&KEY, b"just a file").is_err());
        assert!(open(&KEY, MAGIC).is_err());
    }

    #[test]
    fn an_empty_file_seals_too() {
        let sealed = seal(&KEY, b"").unwrap();
        assert!(is_sealed(&sealed));
        assert_eq!(open(&KEY, &sealed).unwrap(), b"");
    }
}
