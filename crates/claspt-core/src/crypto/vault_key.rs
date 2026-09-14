// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Master-key lifecycle: the random 256-bit master key is wrapped (AES-256-GCM
//! encrypted) under the Argon2id password key and stored in the `vault.key` file
//! as `version(1) ‖ salt(16) ‖ nonce(12) ‖ ciphertext(32) ‖ tag(16)`, written
//! atomically with 0o600 permissions. This indirection is the key invariant:
//! the password only ever wraps the master key, so changing the password (or
//! recovering with the raw master key) re-wraps `vault.key` without touching any
//! `enc:v1:` secret ciphertext. Recovery is guarded by a stored SHA-256
//! verification hash so a wrong recovery key is rejected before overwriting.
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use ring::rand::{SecureRandom, SystemRandom};
use zeroize::Zeroizing;

use ring::digest;

use super::aead;
use super::error::CryptoError;
use super::kdf;

/// Salt length for Argon2id (16 bytes = 128 bits).
const SALT_LEN: usize = 16;

/// Current vault key file format version.
const VAULT_KEY_VERSION: u8 = 1;

// vault.key file format:
//
//   [version: 1 byte] [salt: 16 bytes] [encrypted_master_key: variable]
//
// The encrypted_master_key is: nonce (12) || ciphertext || tag (16)
// where ciphertext is the 32-byte master key encrypted with the password-derived key.

/// Encrypt the master key with a password-derived key using a fresh random salt,
/// and atomically write the vault.key file with 0o600 permissions.
fn write_vault_key_file(
    password: &[u8],
    master_key: &[u8],
    vault_key_path: &Path,
) -> Result<(), CryptoError> {
    // Generate random salt
    let rng = SystemRandom::new();
    let mut salt = [0u8; SALT_LEN];
    rng.fill(&mut salt)
        .map_err(|_| CryptoError::Encryption("salt generation failed".into()))?;

    // Derive password key (auto-zeroed on drop)
    let password_key = kdf::derive_key(password, &salt)?;

    // Encrypt master key with password-derived key
    let encrypted_master_key = aead::encrypt(&password_key, master_key)?;

    // Assemble vault.key: version || salt || encrypted_master_key
    let mut file_data = Vec::with_capacity(1 + SALT_LEN + encrypted_master_key.len());
    file_data.push(VAULT_KEY_VERSION);
    file_data.extend_from_slice(&salt);
    file_data.extend_from_slice(&encrypted_master_key);

    // Write to temp file, set permissions, atomic rename
    let tmp_path = vault_key_path.with_extension("key.tmp");
    std::fs::write(&tmp_path, &file_data)?;
    crate::fs_perms::restrict_to_owner(&tmp_path)?;

    if let Err(e) = std::fs::rename(&tmp_path, vault_key_path) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(CryptoError::from(e));
    }

    Ok(())
}

/// Write an already-known master key wrapped by `password` to `path`, in the
/// `vault.key` format. This is how a headless server gets its own unlock
/// file: the same master key, wrapped by a different passphrase, so the
/// vault's own password never has to sit on the server.
pub fn write_key_file(password: &[u8], master_key: &[u8], path: &Path) -> Result<(), CryptoError> {
    write_vault_key_file(password, master_key, path)
}

/// Create a new vault key: generate a random master key, encrypt it with
/// the password-derived key, and write the vault.key file.
///
/// Returns the plaintext master key wrapped in Zeroizing (auto-zeroed on drop).
pub fn create_vault_key(
    password: &[u8],
    vault_key_path: &Path,
) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    let master_key = aead::generate_master_key()?;
    write_vault_key_file(password, &master_key, vault_key_path)?;
    Ok(master_key)
}

/// Read a vault.key file and decrypt the master key using the given password.
///
/// Returns the plaintext master key wrapped in Zeroizing (auto-zeroed on drop).
pub fn unlock_vault_key(
    password: &[u8],
    vault_key_path: &Path,
) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    let file_data = std::fs::read(vault_key_path)?;

    // Minimum: version (1) + salt (16) + nonce (12) + tag (16) = 45 bytes
    if file_data.len() < 1 + SALT_LEN + aead::NONCE_LEN + 16 {
        return Err(CryptoError::InvalidVaultKey("file too short".into()));
    }

    let version = file_data[0];
    if version != VAULT_KEY_VERSION {
        return Err(CryptoError::InvalidVaultKey(format!(
            "unsupported version: {version}"
        )));
    }

    let salt = &file_data[1..1 + SALT_LEN];
    let encrypted_master_key = &file_data[1 + SALT_LEN..];

    // Derive password key (auto-zeroed on drop)
    let password_key = kdf::derive_key(password, salt)?;

    // Decrypt master key (Zeroizing wrapper auto-zeroes the intermediate)
    let master_key = aead::decrypt(&password_key, encrypted_master_key)?;

    Ok(master_key)
}

/// Re-encrypt the master key with a new password. Reads the existing vault.key,
/// decrypts with old password, re-encrypts with new password, and overwrites.
#[allow(dead_code)]
pub fn change_password(
    old_password: &[u8],
    new_password: &[u8],
    vault_key_path: &Path,
) -> Result<(), CryptoError> {
    let master_key = unlock_vault_key(old_password, vault_key_path)?;
    write_vault_key_file(new_password, &master_key, vault_key_path)
}

/// Recover the vault using a recovery key (base64-encoded master key).
/// Validates the key against the stored verification hash (if present),
/// re-encrypts with the new password, and atomically overwrites vault.key.
/// Returns the recovered master key.
///
/// `verify_hash` is the `master_key_verify` field from config.json.
/// If `None` (legacy vaults), the key is accepted without verification.
pub fn recover_with_key(
    recovery_key_b64: &str,
    new_password: &[u8],
    vault_key_path: &Path,
    verify_hash: Option<&str>,
) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    let decoded = BASE64
        .decode(recovery_key_b64.trim())
        .map_err(|_| CryptoError::InvalidVaultKey("invalid recovery key format".into()))?;

    if decoded.len() != 32 {
        return Err(CryptoError::InvalidVaultKey(format!(
            "recovery key must decode to 32 bytes, got {}",
            decoded.len()
        )));
    }

    let master_key = Zeroizing::new(decoded);

    // Verify recovery key against stored hash (if present)
    if let Some(expected_hash) = verify_hash {
        let actual_hash = compute_master_key_verify(&master_key);
        if actual_hash != expected_hash {
            return Err(CryptoError::InvalidVaultKey(
                "recovery key does not match this vault".into(),
            ));
        }
    }

    if !vault_key_path.exists() {
        return Err(CryptoError::InvalidVaultKey("vault.key not found".into()));
    }

    // Legacy vaults have no `master_key_verify`, so a wrong recovery key cannot
    // be detected here and overwriting vault.key would make existing secrets
    // (encrypted under the original master key) permanently undecryptable. Keep
    // a one-shot backup of the current key file first so the operation stays
    // reversible if the user supplied the wrong recovery key.
    if verify_hash.is_none() {
        let mut backup = vault_key_path.as_os_str().to_owned();
        backup.push(".recovery.bak");
        let backup_path = PathBuf::from(backup);
        if !backup_path.exists() {
            std::fs::copy(vault_key_path, &backup_path).map_err(|e| {
                CryptoError::InvalidVaultKey(format!("could not back up vault.key: {e}"))
            })?;
        }
    }

    write_vault_key_file(new_password, &master_key, vault_key_path)?;
    Ok(master_key)
}

/// Compute a verification hash for the master key: SHA-256(master_key || "claspt-verify").
/// This hash is stored in config.json to verify recovery keys before overwriting vault.key.
pub fn compute_master_key_verify(master_key: &[u8]) -> String {
    let mut ctx = digest::Context::new(&digest::SHA256);
    ctx.update(master_key);
    ctx.update(b"claspt-verify");
    let hash = ctx.finish();
    // Encode as hex without pulling in the `hex` crate
    hash.as_ref()
        .iter()
        .fold(String::with_capacity(64), |mut s, b| {
            use std::fmt::Write;
            let _ = write!(s, "{b:02x}");
            s
        })
}

/// Encrypt a secret block value using the master key.
/// Returns base64-encoded `nonce || ciphertext || tag`.
///
/// KNOWN LIMITATION (integrity, not confidentiality): the block is sealed with
/// empty AAD, so the ciphertext is not cryptographically bound to its label,
/// page id, or field. An attacker with write access to the plaintext `.md`
/// files could relocate an `enc:v1:` blob under a different label and it would
/// still decrypt under the same master key. This does not disclose plaintext
/// and requires filesystem write access. Binding `page_id + label` as AAD is
/// the fix, but it changes the on-disk format: existing `enc:v1:` blobs were
/// sealed with empty AAD, so it must ship as a versioned `enc:v2:` format with
/// a decrypt fallback (try v2/AAD, then legacy empty-AAD) to avoid making every
/// existing secret — on desktop AND the mobile app that shares this crate —
/// undecryptable. Tracked as a deliberate, backward-compatible migration.
pub fn encrypt_block(master_key: &[u8], plaintext: &str) -> Result<String, CryptoError> {
    let encrypted = aead::encrypt(master_key, plaintext.as_bytes())?;
    Ok(BASE64.encode(&encrypted))
}

/// Decrypt a secret block value using the master key.
/// Input is base64-encoded `nonce || ciphertext || tag`.
/// Returns `Zeroizing<String>`, so this function's own copy is wiped on drop.
///
/// That protection ends at the caller: `pages::secret` copies the value into a
/// plain `String` for the page body, which then crosses IPC into the webview.
/// Decrypted values are not zeroized end to end, deliberately — see ADR 0002.
pub fn decrypt_block(master_key: &[u8], encoded: &str) -> Result<Zeroizing<String>, CryptoError> {
    let data = Zeroizing::new(BASE64.decode(encoded)?);
    let plaintext = aead::decrypt(master_key, &data)?;
    let s = String::from_utf8(plaintext.to_vec()).map_err(|_| CryptoError::Decryption)?;
    Ok(Zeroizing::new(s))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn test_password() -> &'static [u8] {
        b"test-master-password"
    }

    #[test]
    fn create_and_unlock_vault_key() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("vault.key");

        let master_key = create_vault_key(test_password(), &path).unwrap();
        assert_eq!(master_key.len(), 32);
        assert!(path.exists());

        let unlocked = unlock_vault_key(test_password(), &path).unwrap();
        assert_eq!(master_key, unlocked);
    }

    #[test]
    fn wrong_password_fails() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("vault.key");

        create_vault_key(test_password(), &path).unwrap();

        let result = unlock_vault_key(b"wrong-password-long", &path);
        assert!(result.is_err());
    }

    #[test]
    fn change_password_works() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("vault.key");

        let original_master_key = create_vault_key(test_password(), &path).unwrap();

        let new_password = b"new-master-password!";
        change_password(test_password(), new_password, &path).unwrap();

        // Old password no longer works
        assert!(unlock_vault_key(test_password(), &path).is_err());

        // New password returns same master key
        let unlocked = unlock_vault_key(new_password, &path).unwrap();
        assert_eq!(original_master_key, unlocked);
    }

    #[test]
    fn vault_key_file_format() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("vault.key");

        create_vault_key(test_password(), &path).unwrap();

        let data = fs::read(&path).unwrap();
        // version (1) + salt (16) + nonce (12) + master_key_ciphertext (32) + tag (16) = 77
        assert_eq!(data.len(), 77);
        assert_eq!(data[0], VAULT_KEY_VERSION);
    }

    #[test]
    fn corrupted_vault_key_fails() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("vault.key");

        create_vault_key(test_password(), &path).unwrap();

        // Corrupt the file
        let mut data = fs::read(&path).unwrap();
        data[30] ^= 0xff;
        fs::write(&path, &data).unwrap();

        assert!(unlock_vault_key(test_password(), &path).is_err());
    }

    #[test]
    fn encrypt_decrypt_block_roundtrip() {
        let master_key = aead::generate_master_key().unwrap();
        let secret = "my-api-key-12345";

        let encoded = encrypt_block(&master_key, secret).unwrap();
        // Should be valid base64
        assert!(BASE64.decode(&encoded).is_ok());

        let decrypted = decrypt_block(&master_key, &encoded).unwrap();
        assert_eq!(&*decrypted, secret);
    }

    #[test]
    fn block_encryption_unique_per_call() {
        let master_key = aead::generate_master_key().unwrap();
        let secret = "same-secret";

        let enc1 = encrypt_block(&master_key, secret).unwrap();
        let enc2 = encrypt_block(&master_key, secret).unwrap();
        assert_ne!(enc1, enc2); // Different nonces → different ciphertexts
    }

    #[cfg(unix)]
    #[test]
    fn vault_key_has_owner_only_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempdir().unwrap();
        let path = dir.path().join("vault.key");

        create_vault_key(test_password(), &path).unwrap();

        let metadata = fs::metadata(&path).unwrap();
        let mode = metadata.permissions().mode() & 0o777;
        assert_eq!(
            mode, 0o600,
            "vault.key should have 0o600 permissions, got {mode:o}"
        );
    }

    #[test]
    fn recover_with_valid_key() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("vault.key");

        let master_key = create_vault_key(test_password(), &path).unwrap();
        let recovery_key = BASE64.encode(&*master_key);
        let verify_hash = compute_master_key_verify(&master_key);

        // Recovery with new password (with verification hash)
        let new_password = b"new-recovery-password!";
        let recovered =
            recover_with_key(&recovery_key, new_password, &path, Some(&verify_hash)).unwrap();
        assert_eq!(*master_key, *recovered);

        // Old password no longer works
        assert!(unlock_vault_key(test_password(), &path).is_err());

        // New password works and returns same master key
        let unlocked = unlock_vault_key(new_password, &path).unwrap();
        assert_eq!(*master_key, *unlocked);
    }

    #[test]
    fn recover_with_invalid_key_fails() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("vault.key");

        let master_key = create_vault_key(test_password(), &path).unwrap();
        let verify_hash = compute_master_key_verify(&master_key);

        // Invalid base64
        assert!(recover_with_key("not-base64!!!", b"new-password-long", &path, None).is_err());

        // Wrong length (16 bytes instead of 32)
        let short_key = BASE64.encode([0u8; 16]);
        assert!(recover_with_key(&short_key, b"new-password-long", &path, None).is_err());

        // Wrong key with verification hash — should be rejected
        let wrong_key = BASE64.encode([0xABu8; 32]);
        assert!(
            recover_with_key(&wrong_key, b"new-password-long", &path, Some(&verify_hash)).is_err()
        );
    }

    #[test]
    fn compute_master_key_verify_deterministic() {
        let key = [0x42u8; 32];
        let hash1 = compute_master_key_verify(&key);
        let hash2 = compute_master_key_verify(&key);
        assert_eq!(hash1, hash2);
        assert_eq!(hash1.len(), 64); // 32 bytes = 64 hex chars
    }

    #[test]
    fn recover_without_verify_hash_accepts_any_valid_key() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("vault.key");

        create_vault_key(test_password(), &path).unwrap();

        // Any 32-byte key should work without verification hash (legacy vault)
        let any_key = BASE64.encode([0xCDu8; 32]);
        assert!(recover_with_key(&any_key, b"new-password-long", &path, None).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn recover_preserves_owner_only_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempdir().unwrap();
        let path = dir.path().join("vault.key");

        let master_key = create_vault_key(test_password(), &path).unwrap();
        let recovery_key = BASE64.encode(&*master_key);

        recover_with_key(&recovery_key, b"new-recovery-password!", &path, None).unwrap();

        let metadata = fs::metadata(&path).unwrap();
        let mode = metadata.permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[cfg(unix)]
    #[test]
    fn change_password_preserves_owner_only_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempdir().unwrap();
        let path = dir.path().join("vault.key");

        create_vault_key(test_password(), &path).unwrap();
        change_password(test_password(), b"new-master-password!", &path).unwrap();

        let metadata = fs::metadata(&path).unwrap();
        let mode = metadata.permissions().mode() & 0o777;
        assert_eq!(
            mode, 0o600,
            "vault.key should have 0o600 after password change, got {mode:o}"
        );
    }
}
