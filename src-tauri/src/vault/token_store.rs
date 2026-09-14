// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! OS keychain storage for the few local API tokens that must be kept in
//! plaintext on this machine.
//!
//! Since 3.3.7 the API authenticates against hashed client records
//! (`local_api::clients`), so the shared notes/secrets/legacy slots this store
//! once held are read only to migrate them and then deleted. What remains is
//! the CLI's own token: the CLI is a client like any other, and the platform
//! keychain (Keychain Services, Windows Credential Manager, or the Secret
//! Service) is where a client on this machine keeps its credential.
//!
//! Entries are scoped by `vault_id`, so several vaults on one machine do not
//! collide.
//!
//! **Availability.** The keychain can be genuinely unavailable — a Linux session
//! with no Secret Service daemon, for instance — which is why [`load`]
//! distinguishes "no such token" from "could not ask".

use keyring::Entry;
use zeroize::Zeroizing;

const SERVICE: &str = "in.indivar.claspt";

/// Which of the vault's API tokens an entry holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenKind {
    /// Notes-only token (`clsn_*`).
    Notes,
    /// Full-access token (`clss_*`), which can decrypt secrets.
    Secrets,
    /// Pre-scoped token (`clsp_*`), kept for vaults that predate scoping.
    Legacy,
    /// The token the CLI on this machine uses for its own requests. The only
    /// plaintext token this store still holds: it belongs to one client, the
    /// way a paired extension holds its own.
    Cli,
}

impl TokenKind {
    fn slug(self) -> &'static str {
        match self {
            Self::Notes => "notes",
            Self::Secrets => "secrets",
            Self::Legacy => "legacy",
            Self::Cli => "cli",
        }
    }
}

/// Why a keychain operation did not succeed.
#[derive(Debug)]
pub enum TokenStoreError {
    /// The keychain itself could not be reached. The caller should fall back to
    /// the config file rather than conclude the token does not exist.
    Unavailable(String),
}

impl std::fmt::Display for TokenStoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable(msg) => write!(f, "keychain unavailable: {msg}"),
        }
    }
}

impl std::error::Error for TokenStoreError {}

/// Keychain account name for one vault's token of one kind.
///
/// The `vault_id` suffix is what keeps two vaults on the same machine apart.
fn account(vault_id: &str, kind: TokenKind) -> String {
    format!("api-token.{}.{}", kind.slug(), vault_id)
}

fn entry(vault_id: &str, kind: TokenKind) -> Result<Entry, TokenStoreError> {
    Entry::new(SERVICE, &account(vault_id, kind))
        .map_err(|e| TokenStoreError::Unavailable(e.to_string()))
}

/// Store a token, replacing any existing one of the same kind for this vault.
pub fn store(vault_id: &str, kind: TokenKind, token: &str) -> Result<(), TokenStoreError> {
    entry(vault_id, kind)?
        .set_password(token)
        .map_err(|e| TokenStoreError::Unavailable(e.to_string()))
}

/// Read a token.
///
/// `Ok(None)` means the keychain was reachable and holds no such token — a vault
/// that has not minted one, or one not yet migrated. `Err(Unavailable)` means
/// the keychain could not be consulted at all, which is a different situation
/// and must not be read as "no token".
pub fn load(vault_id: &str, kind: TokenKind) -> Result<Option<Zeroizing<String>>, TokenStoreError> {
    match entry(vault_id, kind)?.get_password() {
        Ok(token) => Ok(Some(Zeroizing::new(token))),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(TokenStoreError::Unavailable(e.to_string())),
    }
}

/// Remove a token. Deleting one that is not there succeeds.
pub fn delete(vault_id: &str, kind: TokenKind) -> Result<(), TokenStoreError> {
    match entry(vault_id, kind)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(TokenStoreError::Unavailable(e.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accounts_are_scoped_per_vault_and_per_kind() {
        // Two vaults on one machine must not overwrite each other's tokens, and
        // the notes token must never be returned in place of the secrets one.
        let a = account("vault-a", TokenKind::Notes);
        let b = account("vault-b", TokenKind::Notes);
        assert_ne!(a, b, "two vaults share a keychain account name");

        let notes = account("vault-a", TokenKind::Notes);
        let secrets = account("vault-a", TokenKind::Secrets);
        let legacy = account("vault-a", TokenKind::Legacy);
        assert_ne!(notes, secrets);
        assert_ne!(notes, legacy);
        assert_ne!(secrets, legacy);
    }

    #[test]
    fn account_names_are_stable() {
        // These strings are persisted in the user's keychain. Changing one
        // orphans the entry it used to name and silently loses the token, so
        // this test exists to make such a change deliberate.
        assert_eq!(
            account("abc-123", TokenKind::Notes),
            "api-token.notes.abc-123"
        );
        assert_eq!(
            account("abc-123", TokenKind::Secrets),
            "api-token.secrets.abc-123"
        );
        assert_eq!(
            account("abc-123", TokenKind::Legacy),
            "api-token.legacy.abc-123"
        );
    }
}
