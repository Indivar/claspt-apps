// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

use claspt_core::crypto::{group_key, vault_key};
use claspt_core::pages::secret;
#[cfg(feature = "pro")]
use claspt_core::sync::encrypt::{self, WireBundleType};
use std::fs;
use tempfile::TempDir;

#[test]
fn full_vault_lifecycle() {
    let tmp = TempDir::new().unwrap();
    let vault_key_path = tmp.path().join("vault.key");

    // Create vault key
    let master_key = vault_key::create_vault_key(b"test-password-123", &vault_key_path).unwrap();
    assert_eq!(master_key.len(), 32);

    // Unlock vault key
    let unlocked = vault_key::unlock_vault_key(b"test-password-123", &vault_key_path).unwrap();
    assert_eq!(*master_key, *unlocked);

    // Wrong password fails
    assert!(vault_key::unlock_vault_key(b"wrong-password", &vault_key_path).is_err());
}

#[test]
fn secret_block_roundtrip_with_vault_key() {
    let tmp = TempDir::new().unwrap();
    let vault_key_path = tmp.path().join("vault.key");
    let master_key = vault_key::create_vault_key(b"password", &vault_key_path).unwrap();

    let content = "\
# My Note

:::secret[API Key]
sk-live-12345
:::

Regular text.";

    let encrypted = secret::encrypt_secrets(content, &master_key).unwrap();
    assert!(!encrypted.contains("sk-live-12345"));
    assert!(encrypted.contains(":::secret[API Key]"));

    let decrypted = secret::decrypt_secrets(&encrypted, &master_key).unwrap();
    assert_eq!(decrypted, content);
}

// Sync bundles are not part of every build; see the `pro` feature.
#[cfg(feature = "pro")]
#[test]
fn sync_bundle_encrypt_decrypt_roundtrip() {
    let group_key = group_key::derive_group_key(b"password", "vault-123").unwrap();

    let fake_bundle = b"# v2 git bundle\n\nSome pack data here...";

    let encrypted = encrypt::encrypt_bundle_with_device(
        &group_key,
        fake_bundle,
        WireBundleType::Incremental,
        "device-abc",
    )
    .unwrap();

    // Verify device prefix
    let prefix = encrypt::extract_device_prefix(&encrypted).unwrap();
    assert_eq!(prefix, "device-a");

    // Decrypt
    let (decrypted, bundle_type) = encrypt::decrypt_bundle(&group_key, &encrypted).unwrap();
    assert_eq!(decrypted, fake_bundle);
    assert_eq!(bundle_type, WireBundleType::Incremental);
}

// Sync bundles are not part of every build; see the `pro` feature.
#[cfg(feature = "pro")]
#[test]
fn git_init_commit_and_bundle() {
    let tmp = TempDir::new().unwrap();
    let vault_dir = tmp.path();

    // Init repo
    git2::Repository::init(vault_dir).unwrap();

    // Create a test file
    fs::create_dir_all(vault_dir.join("general")).unwrap();
    fs::write(
        vault_dir.join("general/test-note.md"),
        "---\nid: test-1\ntitle: Test\n---\n\nHello world",
    )
    .unwrap();

    // Commit
    let oid = claspt_core::git::ops::commit_changes(vault_dir, "Test note").unwrap();
    assert!(oid.is_some());

    // Create snapshot bundle
    let bundle = claspt_core::sync::bundle::create_full_bundle(vault_dir).unwrap();
    assert!(!bundle.is_empty());

    // Apply bundle to a new repo
    let tmp2 = TempDir::new().unwrap();
    git2::Repository::init(tmp2.path()).unwrap();

    let result = claspt_core::sync::bundle::apply_bundle(tmp2.path(), &bundle).unwrap();
    assert!(result.commits_applied > 0);

    // Verify file was transferred
    let content = fs::read_to_string(tmp2.path().join("general/test-note.md")).unwrap();
    assert!(content.contains("Hello world"));
}
