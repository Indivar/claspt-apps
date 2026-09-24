// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! The key a device signs its sync requests with.
//!
//! Each device makes an Ed25519 key pair when it registers and gives the
//! server the public half. The private half stays in the device's keychain
//! and signs every sync request, so the server, and the TLS edge that sees
//! every header, holds nothing that could act as the device. The licence
//! token alone used to key the request signature; every device of an owner
//! carries the same token, so it identified the owner, not the device.
//!
//! The signed message is the same on every platform and on the server:
//! method, path with its query, the raw body, the device id, the timestamp
//! and the nonce, concatenated as bytes. The server keeps its own copy of
//! that construction (it does not depend on this crate); the known-answer
//! test below and its twin in the server pin the two to each other.

use ring::signature::{Ed25519KeyPair, KeyPair};
use zeroize::Zeroizing;

use super::error::CryptoError;

/// A fresh Ed25519 key pair as PKCS#8 bytes, the form the keychain stores.
pub fn generate() -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    let pkcs8 = Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new())
        .map_err(|_| CryptoError::KeyDerivation("device key generation failed".into()))?;
    Ok(Zeroizing::new(pkcs8.as_ref().to_vec()))
}

fn key_pair(pkcs8: &[u8]) -> Result<Ed25519KeyPair, CryptoError> {
    Ed25519KeyPair::from_pkcs8(pkcs8).map_err(|_| {
        CryptoError::InvalidVaultKey("device key is not a valid Ed25519 PKCS#8 key".into())
    })
}

/// The 32-byte public half, which the server keeps.
pub fn public_key(pkcs8: &[u8]) -> Result<Vec<u8>, CryptoError> {
    Ok(key_pair(pkcs8)?.public_key().as_ref().to_vec())
}

/// The 64-byte signature over `message`.
pub fn sign(pkcs8: &[u8], message: &[u8]) -> Result<Vec<u8>, CryptoError> {
    Ok(key_pair(pkcs8)?.sign(message).as_ref().to_vec())
}

/// The bytes a request is signed over.
pub fn signing_message(
    method: &str,
    path_and_query: &str,
    body: &[u8],
    device_id: &str,
    timestamp: &str,
    nonce: &str,
) -> Vec<u8> {
    let mut message = Vec::with_capacity(
        method.len()
            + path_and_query.len()
            + body.len()
            + device_id.len()
            + timestamp.len()
            + nonce.len(),
    );
    message.extend_from_slice(method.as_bytes());
    message.extend_from_slice(path_and_query.as_bytes());
    message.extend_from_slice(body);
    message.extend_from_slice(device_id.as_bytes());
    message.extend_from_slice(timestamp.as_bytes());
    message.extend_from_slice(nonce.as_bytes());
    message
}

/// HMAC-SHA256 keyed on the licence token: the signature clients used
/// before device keys, still needed for the register and verify calls a
/// device makes before the server knows its key.
pub fn licence_hmac(license_token: &[u8], message: &[u8]) -> Vec<u8> {
    let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, license_token);
    ring::hmac::sign(&key, message).as_ref().to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_generated_key_signs_what_its_public_half_verifies() {
        let pkcs8 = generate().unwrap();
        let public = public_key(&pkcs8).unwrap();
        assert_eq!(public.len(), 32);
        let message = signing_message("GET", "/api/v2/sync/status", b"", "dev", "1", "n");
        let signature = sign(&pkcs8, &message).unwrap();
        assert_eq!(signature.len(), 64);
        let verifier = ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, &public);
        assert!(verifier.verify(&message, &signature).is_ok());
        assert!(verifier.verify(b"other", &signature).is_err());
        let other = generate().unwrap();
        assert_ne!(public_key(&other).unwrap(), public);
    }

    #[test]
    fn garbage_is_not_a_key() {
        assert!(public_key(b"not pkcs8").is_err());
        assert!(sign(b"not pkcs8", b"m").is_err());
    }

    /// Pinned to the server's `device_signing::signing_message`: the same
    /// inputs must give the same bytes there, or signatures stop verifying.
    #[test]
    fn signing_message_known_answer() {
        let message = signing_message(
            "POST",
            "/api/v2/vault/push?version=3&bundle_type=incremental",
            &[0x00, 0xff, 0x10],
            "a1b2",
            "1700000000000",
            "0123456789abcdef",
        );
        let mut expected = b"POST/api/v2/vault/push?version=3&bundle_type=incremental".to_vec();
        expected.extend_from_slice(&[0x00, 0xff, 0x10]);
        expected.extend_from_slice(b"a1b217000000000000123456789abcdef");
        assert_eq!(message, expected);
    }

    #[test]
    fn licence_hmac_matches_ring_directly() {
        let mac = licence_hmac(b"token", b"message");
        let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, b"token");
        assert_eq!(mac, ring::hmac::sign(&key, b"message").as_ref());
        assert_eq!(mac.len(), 32);
    }
}
