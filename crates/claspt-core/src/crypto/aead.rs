// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! AES-256-GCM seal/open primitive plus master-key and nonce generation. Every
//! call to [`encrypt`] draws a fresh 96-bit CSPRNG nonce and returns
//! `nonce ‖ ciphertext ‖ tag`; keys are always 32 bytes. Invariant: a nonce is
//! never reused under a given key, which the one-shot `SingleNonce` sequence and
//! per-encryption random nonce together guarantee — reuse would break GCM's
//! confidentiality and authentication.
use ring::aead::{self, Aad, BoundKey, Nonce, NonceSequence, OpeningKey, SealingKey, UnboundKey};
use ring::error::Unspecified;
use ring::rand::{SecureRandom, SystemRandom};
use zeroize::Zeroizing;

use super::error::CryptoError;

/// Nonce length for AES-256-GCM (96 bits = 12 bytes).
pub const NONCE_LEN: usize = 12;
/// AES-256-GCM authentication tag length (128 bits = 16 bytes).
pub const TAG_LEN: usize = 16;

/// A nonce sequence that uses a single pre-generated random nonce.
/// Used for one-shot encrypt/decrypt operations.
struct SingleNonce(Option<[u8; NONCE_LEN]>);

impl NonceSequence for SingleNonce {
    fn advance(&mut self) -> Result<Nonce, Unspecified> {
        // SAFETY (nonce uniqueness): the wrapped nonce is a fresh 96-bit value
        // drawn from the system CSPRNG by `generate_nonce` for this single
        // encryption. `take()` yields it exactly once (subsequent calls return
        // `Unspecified`), so `assume_unique_for_key`'s contract holds — this key
        // never sees a repeated nonce. The vault master key encrypts a bounded
        // number of short secret blocks, staying far below the ~2^32-message
        // birthday bound for random 96-bit nonces.
        self.0
            .take()
            .map(Nonce::assume_unique_for_key)
            .ok_or(Unspecified)
    }
}

/// Generate a cryptographically random 96-bit nonce.
pub fn generate_nonce() -> Result<[u8; NONCE_LEN], CryptoError> {
    let rng = SystemRandom::new();
    let mut nonce = [0u8; NONCE_LEN];
    rng.fill(&mut nonce)
        .map_err(|_| CryptoError::Encryption("nonce generation failed".into()))?;
    Ok(nonce)
}

/// Generate a cryptographically random 256-bit (32-byte) master key.
/// Returns `Zeroizing<Vec<u8>>` so the key is automatically zeroed on drop.
pub fn generate_master_key() -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    let rng = SystemRandom::new();
    let mut key = Zeroizing::new(vec![0u8; 32]);
    rng.fill(&mut key)
        .map_err(|_| CryptoError::Encryption("master key generation failed".into()))?;
    Ok(key)
}

/// Seal `plaintext` with AES-256-GCM under `key`, a caller-provided 96-bit
/// `nonce`, and associated data `aad`. Returns `ciphertext || tag` — the nonce
/// is NOT prepended, so the caller decides how to carry it.
///
/// This is the single place that drives `ring`'s sealing; higher-level
/// encryptors ([`encrypt`], the sync-bundle encryptor) build on it.
///
/// SAFETY (nonce uniqueness): the caller MUST pass a `nonce` never before used
/// with this `key`. [`encrypt`] satisfies this with a fresh CSPRNG nonce per
/// call; the sync-bundle encryptor draws a fresh nonce per bundle.
pub fn seal_with_nonce_aad(
    key: &[u8],
    nonce: [u8; NONCE_LEN],
    aad: &[u8],
    plaintext: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    let unbound_key = UnboundKey::new(&aead::AES_256_GCM, key)
        .map_err(|_| CryptoError::Encryption("invalid key".into()))?;
    let mut sealing_key = SealingKey::new(unbound_key, SingleNonce(Some(nonce)));
    // ring appends the tag to the buffer in-place.
    let mut in_out = plaintext.to_vec();
    sealing_key
        .seal_in_place_append_tag(Aad::from(aad), &mut in_out)
        .map_err(|_| CryptoError::Encryption("seal failed".into()))?;
    Ok(in_out)
}

/// Open `ciphertext_and_tag` produced by [`seal_with_nonce_aad`] with the same
/// `key`, `nonce`, and `aad`. A wrong key, wrong nonce, wrong AAD, or any
/// tampering fails with an opaque [`CryptoError::Decryption`] (no distinguishing
/// oracle).
pub fn open_with_nonce_aad(
    key: &[u8],
    nonce: [u8; NONCE_LEN],
    aad: &[u8],
    ciphertext_and_tag: &[u8],
) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    let unbound_key =
        UnboundKey::new(&aead::AES_256_GCM, key).map_err(|_| CryptoError::Decryption)?;
    let mut opening_key = OpeningKey::new(unbound_key, SingleNonce(Some(nonce)));
    let mut in_out = Zeroizing::new(ciphertext_and_tag.to_vec());
    let plaintext = opening_key
        .open_in_place(Aad::from(aad), &mut in_out)
        .map_err(|_| CryptoError::Decryption)?;
    Ok(Zeroizing::new(plaintext.to_vec()))
}

/// Encrypt plaintext with AES-256-GCM under a fresh random nonce and empty AAD.
///
/// Returns `nonce || ciphertext || tag` (12 + plaintext_len + 16 bytes).
pub fn encrypt(key: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let nonce_bytes = generate_nonce()?;
    let sealed = seal_with_nonce_aad(key, nonce_bytes, &[], plaintext)?;
    // Prepend nonce: nonce || ciphertext || tag.
    let mut result = Vec::with_capacity(NONCE_LEN + sealed.len());
    result.extend_from_slice(&nonce_bytes);
    result.extend_from_slice(&sealed);
    Ok(result)
}

/// Decrypt ciphertext produced by [`encrypt`].
///
/// Input format: `nonce (12) || ciphertext || tag (16)`.
/// Returns the decrypted plaintext.
pub fn decrypt(key: &[u8], data: &[u8]) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    if data.len() < NONCE_LEN + TAG_LEN {
        return Err(CryptoError::Decryption);
    }
    let (nonce_bytes, ciphertext_and_tag) = data.split_at(NONCE_LEN);
    let mut nonce_arr = [0u8; NONCE_LEN];
    nonce_arr.copy_from_slice(nonce_bytes);
    open_with_nonce_aad(key, nonce_arr, &[], ciphertext_and_tag)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Decode a hex string to bytes (test helper for known-answer vectors).
    fn hex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    #[test]
    fn aes_256_gcm_known_answer_vector() {
        // Published NIST AES-256-GCM test vector: all-zero 256-bit key, all-zero
        // 96-bit IV, 16-byte all-zero plaintext, empty AAD. Pins that our
        // primitive drives standard AES-256-GCM correctly — a roundtrip test
        // alone would NOT catch an accidental cipher/param change, but this does.
        let key = [0u8; 32];
        let nonce = [0u8; NONCE_LEN];
        let plaintext = [0u8; 16];
        let expect_ct = hex("cea7403d4d606b6e074ec5d3baf39d18");
        let expect_tag = hex("d0d1c8a799996bf0265b98b5d48ab919");

        let sealed = seal_with_nonce_aad(&key, nonce, &[], &plaintext).unwrap();
        assert_eq!(
            &sealed[..16],
            &expect_ct[..],
            "ciphertext mismatch vs NIST vector"
        );
        assert_eq!(
            &sealed[16..],
            &expect_tag[..],
            "tag mismatch vs NIST vector"
        );

        // And it opens back to the plaintext under the same key/nonce/AAD.
        let opened = open_with_nonce_aad(&key, nonce, &[], &sealed).unwrap();
        assert_eq!(&*opened, &plaintext[..]);
    }

    #[test]
    fn aad_binds_ciphertext() {
        // Sealing with AAD and opening with different AAD must fail authentication.
        let key = [7u8; 32];
        let nonce = [3u8; NONCE_LEN];
        let sealed = seal_with_nonce_aad(&key, nonce, b"header-A", b"secret").unwrap();
        assert!(open_with_nonce_aad(&key, nonce, b"header-B", &sealed).is_err());
        assert_eq!(
            &*open_with_nonce_aad(&key, nonce, b"header-A", &sealed).unwrap(),
            b"secret"
        );
    }

    fn test_key() -> Vec<u8> {
        // Fixed 32-byte key for testing
        vec![
            0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d,
            0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b,
            0x1c, 0x1d, 0x1e, 0x1f,
        ]
    }

    #[test]
    fn encrypt_decrypt_roundtrip() {
        let key = test_key();
        let plaintext = b"Hello, secret world!";
        let encrypted = encrypt(&key, plaintext).unwrap();
        let decrypted = decrypt(&key, &encrypted).unwrap();
        assert_eq!(&*decrypted, plaintext);
    }

    #[test]
    fn decrypt_wrong_key_fails() {
        let key = test_key();
        let plaintext = b"sensitive data";
        let encrypted = encrypt(&key, plaintext).unwrap();

        let mut wrong_key = test_key();
        wrong_key[0] ^= 0xff;
        let result = decrypt(&wrong_key, &encrypted);
        assert!(result.is_err());
    }

    #[test]
    fn nonces_are_unique() {
        let key = test_key();
        let plaintext = b"same plaintext";

        let enc1 = encrypt(&key, plaintext).unwrap();
        let enc2 = encrypt(&key, plaintext).unwrap();

        // Nonces (first 12 bytes) should differ
        assert_ne!(&enc1[..NONCE_LEN], &enc2[..NONCE_LEN]);
        // Ciphertexts should also differ (due to different nonces)
        assert_ne!(enc1, enc2);
    }

    #[test]
    fn tampered_ciphertext_fails() {
        let key = test_key();
        let plaintext = b"integrity check";
        let mut encrypted = encrypt(&key, plaintext).unwrap();

        // Flip a bit in the ciphertext body
        let mid = NONCE_LEN + 1;
        encrypted[mid] ^= 0x01;

        let result = decrypt(&key, &encrypted);
        assert!(result.is_err());
    }

    #[test]
    fn too_short_input_fails() {
        let key = test_key();
        let result = decrypt(&key, &[0u8; 10]);
        assert!(result.is_err());
    }

    #[test]
    fn empty_plaintext_roundtrip() {
        let key = test_key();
        let encrypted = encrypt(&key, b"").unwrap();
        let decrypted = decrypt(&key, &encrypted).unwrap();
        assert_eq!(&*decrypted, b"");
    }

    #[test]
    fn master_key_generation() {
        let key1 = generate_master_key().unwrap();
        let key2 = generate_master_key().unwrap();
        assert_eq!(key1.len(), 32);
        assert_eq!(key2.len(), 32);
        assert_ne!(key1, key2);
    }
}
