// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! The at-rest form of a page follows its content.
//!
//! A save reaches five places: the file on disk, the vault's git history, the
//! sync server, every other synced device, and any backup that copies the
//! folder. A credential pasted into a page as plain text would reach all five
//! in the seconds before the person converts it into a secret block, and the
//! history would keep it for good. So a page that holds a recognisable
//! credential outside a `:::secret` block is written fully encrypted and
//! flagged `auto_encrypted`; once the credential is inside a block, or gone,
//! the page is written plain again with only its blocks sealed. A page the
//! owner chose to encrypt stays chosen and is never unsealed here.
//!
//! The recogniser is [`secret_guard::find_plaintext_secrets`], the same one the
//! local API's write guard uses. It is deliberately conservative: a bare
//! `Project Region: eu-central-1` does not seal a page, a bare API token does.

use std::path::Path;

use super::crud;
use super::error::PageError;
use super::model::Page;
use super::secret;
use super::secret_guard;

/// How a page is written to disk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AtRest {
    /// The whole body is one ciphertext.
    pub encrypted: bool,
    /// The body is encrypted because of what it holds, not because the owner
    /// asked. Cleared by the first save that finds nothing.
    pub auto: bool,
}

/// The at-rest form for `plaintext`, given whether the owner chose full
/// encryption for the page.
pub fn decide(chosen: bool, plaintext: &str) -> AtRest {
    if chosen {
        return AtRest {
            encrypted: true,
            auto: false,
        };
    }
    let auto = !secret_guard::find_plaintext_secrets(plaintext).is_empty();
    AtRest {
        encrypted: auto,
        auto,
    }
}

/// Write `plaintext` to the page at `rel_path` in the form [`decide`] picks,
/// and return the page with its plaintext content and updated metadata.
pub fn store(
    vault_dir: &Path,
    rel_path: &str,
    plaintext: &str,
    chosen: bool,
    key: &[u8],
) -> Result<Page, PageError> {
    let at_rest = decide(chosen, plaintext);
    let on_disk = if at_rest.encrypted {
        secret::encrypt_full_body(plaintext, key)?
    } else {
        secret::encrypt_secrets(plaintext, key)?
    };
    let mut page = crud::update_page_with_meta(vault_dir, rel_path, &on_disk, |meta| {
        meta.encrypted = at_rest.encrypted;
        meta.auto_encrypted = at_rest.auto;
    })?;
    page.content = plaintext.to_string();
    Ok(page)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A GitHub token shape, assembled here so the source holds no string a
    /// secret scanner would stop a commit over.
    fn token() -> String {
        format!("ghp_{}", "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij")
    }

    fn key() -> Vec<u8> {
        vec![7u8; 32]
    }

    fn vault_with_page() -> (tempfile::TempDir, std::path::PathBuf, String) {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path().to_path_buf();
        std::fs::create_dir_all(vault.join("general")).unwrap();
        let page = crud::create_page(&vault, "Servers", "general", "", false).unwrap();
        (dir, vault, page.path)
    }

    #[test]
    fn decide_seals_only_when_a_credential_sits_outside_a_block() {
        let plain = AtRest {
            encrypted: false,
            auto: false,
        };
        assert_eq!(decide(false, "Notes\nHost: db.example.com"), plain);
        assert_eq!(
            decide(false, &format!("token: {}", token())),
            AtRest {
                encrypted: true,
                auto: true
            }
        );
        assert_eq!(
            decide(
                false,
                &format!(":::secret[GitHub]\ntoken: {}\n:::", token())
            ),
            plain
        );
        assert_eq!(
            decide(true, "anything"),
            AtRest {
                encrypted: true,
                auto: false
            }
        );
    }

    #[test]
    fn store_writes_ciphertext_while_a_token_is_bare_and_plain_once_it_is_sealed() {
        let (_d, vault, path) = vault_with_page();
        let page = store(
            &vault,
            &path,
            &format!("Deploy\ntoken: {}\n", token()),
            false,
            &key(),
        )
        .unwrap();
        assert!(page.meta.encrypted && page.meta.auto_encrypted);
        let raw = std::fs::read_to_string(vault.join(&path)).unwrap();
        assert!(
            !raw.contains(&token()),
            "the token must not be on disk in plain text"
        );
        assert!(raw.contains("auto_encrypted: true"));

        let sealed = format!("Deploy\n:::secret[GitHub]\ntoken: {}\n:::\n", token());
        let page = store(&vault, &path, &sealed, false, &key()).unwrap();
        assert!(!page.meta.encrypted && !page.meta.auto_encrypted);
        assert_eq!(page.content, sealed);
        let raw = std::fs::read_to_string(vault.join(&path)).unwrap();
        assert!(raw.contains("Deploy"));
        assert!(!raw.contains(&token()));
        assert!(!raw.contains("auto_encrypted"));
    }

    #[test]
    fn store_seals_a_page_with_a_token_inside_a_code_fence() {
        let (_d, vault, path) = vault_with_page();
        let text = format!(
            "```env\nSTRIPE_KEY={}_{}\n```\n",
            "sk_test", "4eC39HqLyjWDarjtT1zdp7dc"
        );
        let page = store(&vault, &path, &text, false, &key()).unwrap();
        assert!(page.meta.auto_encrypted);
    }

    #[test]
    fn toggle_off_a_chosen_page_that_holds_a_token_keeps_it_sealed() {
        let (_d, vault, path) = vault_with_page();
        let text = format!("token: {}", token());
        let page = store(&vault, &path, &text, true, &key()).unwrap();
        assert!(page.meta.encrypted && !page.meta.auto_encrypted);
        let page = store(&vault, &path, &text, false, &key()).unwrap();
        assert!(page.meta.encrypted && page.meta.auto_encrypted);
    }

    #[test]
    fn a_chosen_page_is_never_unsealed_by_a_save() {
        let (_d, vault, path) = vault_with_page();
        let page = store(&vault, &path, "just notes", true, &key()).unwrap();
        assert!(page.meta.encrypted && !page.meta.auto_encrypted);
    }
}
