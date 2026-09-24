// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! A vault made by an earlier release has to open in this one.
//!
//! Every other test here builds its vault with the current code, so a change
//! to the key file, the config or the secret block format that breaks older
//! vaults would pass them all. `tests/fixtures/vault-3.0.6` was written by the
//! code of release 3.0.6 itself; these tests walk the steps an unlock takes,
//! against a copy of it.

use std::path::{Path, PathBuf};

use crate::crypto::vault_key;
use crate::pages::{crud, secret};
use crate::vault::init;

const PASSWORD: &[u8] = b"made-by-claspt-3.0.6";
const BANK_PAGE: &str = "credentials/2026-09-21-062206-bank-login.md";
const JOURNAL_PAGE: &str = "general/2026-09-21-062206-private-journal.md";

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).unwrap();
        }
    }
}

/// A working copy of the fixture: an unlock writes to the vault (it backfills
/// config fields, and a recovery rewrites the key file), and the fixture has to
/// stay exactly as 3.0.6 left it.
fn a_copy_of_the_old_vault() -> (tempfile::TempDir, PathBuf) {
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/vault-3.0.6");
    let tmp = tempfile::tempdir().unwrap();
    let vault = tmp.path().join("vault");
    copy_dir(&fixture, &vault);
    (tmp, vault)
}

fn key_file(vault: &Path) -> PathBuf {
    vault.join(".securenotes").join("vault.key")
}

#[test]
fn the_master_password_still_opens_it() {
    let (_tmp, vault) = a_copy_of_the_old_vault();
    init::validate_vault_exists(&vault).expect("recognised as a vault");
    let master_key = vault_key::unlock_vault_key(PASSWORD, &key_file(&vault)).unwrap();
    assert_eq!(master_key.len(), 32);
}

#[test]
fn a_wrong_password_is_still_refused() {
    let (_tmp, vault) = a_copy_of_the_old_vault();
    assert!(vault_key::unlock_vault_key(b"not the password", &key_file(&vault)).is_err());
}

/// The config of 3.0.6 has none of the fields added since. It has to read,
/// keep what it had, and take the defaults for the rest.
#[test]
fn its_config_still_reads_and_the_newer_settings_take_their_defaults() {
    let (_tmp, vault) = a_copy_of_the_old_vault();
    let config = init::read_config(&vault).unwrap();
    assert!(config.vault_id.is_some(), "the vault keeps its identity");
    assert!(config.master_key_verify.is_some());
    assert_eq!(config.trash_retention_days, 30);
    config.validate().expect("an old config is a valid config");
}

#[test]
fn a_secret_it_sealed_still_decrypts() {
    let (_tmp, vault) = a_copy_of_the_old_vault();
    let master_key = vault_key::unlock_vault_key(PASSWORD, &key_file(&vault)).unwrap();
    let page = crud::read_page(&vault, BANK_PAGE).unwrap();
    assert_eq!(page.meta.title, "Bank login");
    assert!(page.content.contains("enc:v1:"), "still sealed on disk");
    let opened = secret::decrypt_secrets(&page.content, &master_key).unwrap();
    assert!(opened.contains("hunter2-from-3.0.6"));
    assert!(opened.contains(":::secret[Bank password]"));
}

#[test]
fn a_page_it_encrypted_whole_still_decrypts() {
    let (_tmp, vault) = a_copy_of_the_old_vault();
    let master_key = vault_key::unlock_vault_key(PASSWORD, &key_file(&vault)).unwrap();
    let page = crud::read_page(&vault, JOURNAL_PAGE).unwrap();
    assert!(page.meta.encrypted);
    let opened = secret::decrypt_full_body(&page.content, &master_key).unwrap();
    assert_eq!(opened, "Everything on this page was encrypted by 3.0.6.");
}

/// The sheet someone printed under 3.0.6 is what they will reach for when the
/// password is gone. It has to recover the vault, and the secrets with it.
#[test]
fn the_recovery_key_it_handed_out_still_recovers_the_vault() {
    let (_tmp, vault) = a_copy_of_the_old_vault();
    let recovery_key = std::fs::read_to_string(vault.join("RECOVERY-KEY.txt")).unwrap();
    let config = init::read_config(&vault).unwrap();

    let new_password = b"chosen after the old one was lost";
    let recovered = vault_key::recover_with_key(
        &recovery_key,
        new_password,
        &key_file(&vault),
        config.master_key_verify.as_deref(),
    )
    .unwrap();

    let reopened = vault_key::unlock_vault_key(new_password, &key_file(&vault)).unwrap();
    assert_eq!(*recovered, *reopened);
    assert!(vault_key::unlock_vault_key(PASSWORD, &key_file(&vault)).is_err());

    let page = crud::read_page(&vault, BANK_PAGE).unwrap();
    let opened = secret::decrypt_secrets(&page.content, &reopened).unwrap();
    assert!(opened.contains("hunter2-from-3.0.6"));
}
