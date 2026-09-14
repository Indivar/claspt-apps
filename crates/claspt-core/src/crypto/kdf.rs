// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Argon2id password stretching. [`derive_key`] turns a low-entropy password
//! plus a salt into a 32-byte (256-bit) key using fixed parameters: 64 MiB
//! memory, 3 iterations, parallelism 4. These follow the OWASP-recommended
//! Argon2id profile — the large memory cost is what makes offline brute-force
//! against a stolen `vault.key` expensive on GPUs/ASICs. The derivation is
//! deterministic: identical `(password, salt)` always yields the same key, and
//! the result is `Zeroizing` so it is wiped on drop.
use argon2::{Algorithm, Argon2, Params, Version};
use zeroize::Zeroizing;

use super::error::CryptoError;

/// Argon2id parameters per spec: 64MB memory, 3 iterations, parallelism 4.
const ARGON2_MEMORY_KIB: u32 = 64 * 1024; // 64 MB
const ARGON2_ITERATIONS: u32 = 3;
const ARGON2_PARALLELISM: u32 = 4;
const DERIVED_KEY_LEN: usize = 32; // 256 bits

/// Derive a 256-bit key from a password and salt using Argon2id.
///
/// Returns a 32-byte key wrapped in `Zeroizing` (auto-zeroed on drop).
pub fn derive_key(password: &[u8], salt: &[u8]) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    let params = Params::new(
        ARGON2_MEMORY_KIB,
        ARGON2_ITERATIONS,
        ARGON2_PARALLELISM,
        Some(DERIVED_KEY_LEN),
    )
    .map_err(|e| CryptoError::KeyDerivation(e.to_string()))?;

    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);

    let mut key = Zeroizing::new(vec![0u8; DERIVED_KEY_LEN]);
    argon2
        .hash_password_into(password, salt, &mut key)
        .map_err(|e| CryptoError::KeyDerivation(e.to_string()))?;

    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn argon2id_params_are_pinned() {
        // Guard the Argon2id cost parameters. Silently lowering any of these
        // would weaken every vault's password stretching with no other test
        // failure. Values follow the OWASP-recommended Argon2id profile.
        assert_eq!(ARGON2_MEMORY_KIB, 64 * 1024, "Argon2 memory cost changed");
        assert_eq!(ARGON2_ITERATIONS, 3, "Argon2 iteration cost changed");
        assert_eq!(ARGON2_PARALLELISM, 4, "Argon2 parallelism changed");
        assert_eq!(DERIVED_KEY_LEN, 32, "derived key length changed");
    }

    #[test]
    fn derive_key_known_answer() {
        // Pin the exact Argon2id output for fixed inputs so any change to the
        // algorithm, version, params, or encoding is caught — a self-consistent
        // roundtrip would not notice a silently altered KDF.
        let key = derive_key(b"correct horse battery staple", b"0123456789abcdef").unwrap();
        assert_eq!(key.len(), 32);
        let hex: String = key.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(
            hex,
            "efb51f9a76584f6dd6a4f7942a1a2f6ae5a6e4ec5142ff674dfd5d27eb45e446"
        );
    }

    #[test]
    fn derive_key_consistent() {
        let password = b"test-password-12chars";
        let salt = b"0123456789abcdef"; // 16 bytes
        let key1 = derive_key(password, salt).unwrap();
        let key2 = derive_key(password, salt).unwrap();
        assert_eq!(key1, key2);
        assert_eq!(key1.len(), 32);
    }

    #[test]
    fn derive_key_different_password() {
        let salt = b"0123456789abcdef";
        let key1 = derive_key(b"password-one-long", salt).unwrap();
        let key2 = derive_key(b"password-two-long", salt).unwrap();
        assert_ne!(key1, key2);
    }

    #[test]
    fn derive_key_different_salt() {
        let password = b"same-password-long";
        let key1 = derive_key(password, b"salt-one-16bytes").unwrap();
        let key2 = derive_key(password, b"salt-two-16bytes").unwrap();
        assert_ne!(key1, key2);
    }
}
