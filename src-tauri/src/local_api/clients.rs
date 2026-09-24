// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Named client tokens for the local API.
//!
//! Every process that talks to the API — an MCP client, the browser extension,
//! the CLI, a script — holds its own token, and the token identifies it. This
//! replaces three fixed slots (notes, secrets, legacy) that every client
//! shared, which meant the API could tell a request's scope but never who sent
//! it: nothing could be revoked for one client without cutting off the rest,
//! nothing could be logged against a name, and no approval could be narrowed
//! to a caller. Identity is what the access log, per-client policy and
//! per-client approval grants in the rest of phase 1 hang on.
//!
//! **Only hashes are stored.** The registry holds the SHA-256 of each token,
//! never the token. A token is shown once, when it is minted, and then exists
//! only in the client's own configuration. A copy of `clients.json` therefore
//! yields nothing usable, which the previous keychain-or-config storage of the
//! plaintext could not claim. Lookups hash the presented token and compare in
//! constant time.
//!
//! **Where it lives.** `.securenotes/clients.json`, written owner-only through
//! the same helper as `vault.key`, and excluded from git and sync with the
//! rest of `.securenotes/`: tokens are per device. The app re-reads the file on
//! every request (it is small), so a token minted by the CLI or revoked in
//! Settings takes effect immediately. Writers take an advisory lock on
//! `.securenotes/clients.lock`, because the app and the CLI are separate
//! processes that can both mint.

use std::fs::OpenOptions;
use std::io;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use super::auth::{constant_time_eq, generate_scoped_token, TokenScope};
use crate::vault::config::VaultConfig;
use crate::vault::token_store::{self, TokenKind};

const REGISTRY_FILE: &str = "clients.json";
const LOCK_FILE: &str = "clients.lock";
const MAX_NAME_LEN: usize = 80;

/// One client that may call the API.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientToken {
    pub id: String,
    pub name: String,
    pub scope: TokenScope,
    /// Hex SHA-256 of the token. The token itself is never stored.
    pub token_hash: String,
    /// Prefix and last four characters, enough to match a token in a config
    /// file by eye and useless for anything else.
    pub hint: String,
    pub created_at: DateTime<Utc>,
    /// Memory namespaces this client may touch. Empty means all. Enforced by
    /// the memory routes, not only by the MCP proxy's own check.
    #[serde(default)]
    pub namespaces: Vec<String>,
    /// What kind of client this is, when it matters to a route: "extension"
    /// for tokens minted by pairing. Routes that only the extension may call
    /// (login jobs) check this, not the name, which the user may change.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

/// The on-disk registry. `version` exists so a future shape change can be
/// migrated rather than guessed at.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ClientRegistry {
    #[serde(default = "registry_version")]
    pub version: u32,
    #[serde(default)]
    pub clients: Vec<ClientToken>,
}

fn registry_version() -> u32 {
    1
}

/// A freshly minted token and its registry record. The token is the only
/// copy that will ever exist outside the client that receives it.
pub struct Minted {
    pub token: Zeroizing<String>,
    pub client: ClientToken,
}

impl ClientRegistry {
    /// The client whose token this is, or `None`.
    ///
    /// Every stored hash is compared in constant time. The loop does not stop
    /// at the first match, so the time taken does not depend on where in the
    /// list a valid token sits.
    pub fn find(&self, presented: &str) -> Option<&ClientToken> {
        let presented_hash = hash_token(presented);
        let mut found = None;
        for client in &self.clients {
            if constant_time_eq(client.token_hash.as_bytes(), presented_hash.as_bytes()) {
                found = Some(client);
            }
        }
        found
    }
}

/// Hex SHA-256 of a token, the only form in which tokens are kept.
pub fn hash_token(token: &str) -> String {
    hex::encode(ring::digest::digest(&ring::digest::SHA256, token.as_bytes()).as_ref())
}

/// `clsn_…3f9a`: the scope prefix and the last four characters. Safe to
/// print anywhere: it is what the registry shows next to each client.
pub fn token_hint(token: &str) -> String {
    let prefix_len = 5;
    if token.len() < prefix_len + 4 {
        return "…".to_string();
    }
    format!("{}…{}", &token[..prefix_len], &token[token.len() - 4..])
}

/// A record for a token that already exists (migration) or was just minted.
fn record(
    name: &str,
    scope: TokenScope,
    token: &str,
    namespaces: &[String],
    kind: Option<&str>,
) -> ClientToken {
    ClientToken {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.to_string(),
        scope,
        token_hash: hash_token(token),
        hint: token_hint(token),
        created_at: Utc::now(),
        namespaces: namespaces.to_vec(),
        kind: kind.map(str::to_string),
    }
}

impl ClientToken {
    /// A record for a built-in client that has no token (the SSH agent), so
    /// policy rules can name it like any other client.
    pub fn synthetic(id: &str, name: &str) -> Self {
        Self {
            id: id.to_string(),
            name: name.to_string(),
            scope: TokenScope::Secrets,
            token_hash: String::new(),
            hint: String::new(),
            created_at: Utc::now(),
            namespaces: Vec::new(),
            kind: None,
        }
    }
}

/// Mint a token and its record. Pure: nothing is written.
pub fn mint_with_kind(
    name: &str,
    scope: TokenScope,
    namespaces: &[String],
    kind: Option<&str>,
) -> Minted {
    let token = Zeroizing::new(generate_scoped_token(scope));
    let client = record(name, scope, &token, namespaces, kind);
    Minted { token, client }
}

fn validate_namespaces(namespaces: &[String]) -> io::Result<Vec<String>> {
    let mut out = Vec::new();
    for ns in namespaces {
        let ns = ns.trim();
        if ns.is_empty() {
            continue;
        }
        crate::pages::agent_memory::validate_agent_namespace(ns)
            .map_err(|e| io::Error::other(e.to_string()))?;
        if !out.iter().any(|o| o == ns) {
            out.push(ns.to_string());
        }
    }
    Ok(out)
}

/// A client name a user will recognise in a list: what it is, and where.
pub fn default_name(kind: &str) -> String {
    match gethostname::gethostname().to_str() {
        Some(host) if !host.is_empty() => format!("{kind} on {host}"),
        _ => kind.to_string(),
    }
}

fn validate_name(name: &str) -> io::Result<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(io::Error::other("client name must not be empty"));
    }
    if trimmed.chars().count() > MAX_NAME_LEN {
        return Err(io::Error::other(format!(
            "client name must be at most {MAX_NAME_LEN} characters"
        )));
    }
    if trimmed.chars().any(char::is_control) {
        return Err(io::Error::other(
            "client name must not contain control characters",
        ));
    }
    Ok(trimmed.to_string())
}

fn registry_path(vault_dir: &Path) -> PathBuf {
    vault_dir.join(".securenotes").join(REGISTRY_FILE)
}

/// Read the registry. A vault without one has no clients yet.
pub fn load(vault_dir: &Path) -> io::Result<ClientRegistry> {
    match std::fs::read_to_string(registry_path(vault_dir)) {
        Ok(text) => serde_json::from_str(&text).map_err(io::Error::other),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(ClientRegistry::default()),
        Err(e) => Err(e),
    }
}

fn save(vault_dir: &Path, registry: &ClientRegistry) -> io::Result<()> {
    let json = serde_json::to_string_pretty(registry).map_err(io::Error::other)?;
    crate::vault::init::write_restricted(&registry_path(vault_dir), json.as_bytes())
        .map_err(|e| io::Error::other(e.to_string()))
}

/// Read, change and write the registry under an exclusive advisory lock, so
/// the app and the CLI cannot lose each other's writes.
pub fn with_registry<R>(
    vault_dir: &Path,
    change: impl FnOnce(&mut ClientRegistry) -> io::Result<R>,
) -> io::Result<R> {
    let securenotes = vault_dir.join(".securenotes");
    std::fs::create_dir_all(&securenotes)?;
    let lock_path = securenotes.join(LOCK_FILE);
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&lock_path)?;
    lock.lock()?;
    let outcome = (|| {
        let mut registry = load(vault_dir)?;
        let result = change(&mut registry)?;
        save(vault_dir, &registry)?;
        Ok(result)
    })();
    let _ = lock.unlock();
    outcome
}

/// Mint a token for a new client and record it.
pub fn create(
    vault_dir: &Path,
    name: &str,
    scope: TokenScope,
    namespaces: &[String],
) -> io::Result<Minted> {
    create_with_kind(vault_dir, name, scope, namespaces, None)
}

/// [`create`] for a client of a particular kind (see [`ClientToken::kind`]).
pub fn create_with_kind(
    vault_dir: &Path,
    name: &str,
    scope: TokenScope,
    namespaces: &[String],
    kind: Option<&str>,
) -> io::Result<Minted> {
    let name = validate_name(name)?;
    let namespaces = validate_namespaces(namespaces)?;
    with_registry(vault_dir, |registry| {
        let minted = mint_with_kind(&name, scope, &namespaces, kind);
        registry.clients.push(minted.client.clone());
        Ok(minted)
    })
}

/// Remove a client. Its token stops authenticating on the next request, and
/// every standing approval it held goes with it: a grant for a client that no
/// longer exists is a grant waiting for an id to be reused.
/// Returns whether anything was removed.
pub fn revoke(vault_dir: &Path, id: &str) -> io::Result<bool> {
    let removed = with_registry(vault_dir, |registry| {
        let before = registry.clients.len();
        registry.clients.retain(|c| c.id != id);
        Ok(registry.clients.len() != before)
    })?;
    if removed {
        crate::internal::approval_grants::revoke_all_for_client(vault_dir, id)?;
    }
    Ok(removed)
}

/// All clients, for display. Hashes travel with the records; they cannot be
/// turned back into tokens.
pub fn list(vault_dir: &Path) -> io::Result<Vec<ClientToken>> {
    Ok(load(vault_dir)?.clients)
}

/// Move the pre-registry tokens into the registry as named clients.
///
/// Before the registry, a vault had up to three shared plaintext tokens, in
/// the OS keychain or in `config.json`. Each one that exists becomes a client
/// record holding only its hash, so the token keeps working wherever it was
/// pasted, and the plaintext is deleted from both places. Idempotent: once
/// the slots are empty there is nothing to move. Returns how many moved; the
/// caller persists `config` when that is more than zero.
pub fn migrate_from_slots(vault_dir: &Path, config: &mut VaultConfig) -> io::Result<usize> {
    let vault_id = config.vault_id.clone().filter(|id| !id.is_empty());
    let mut pending: Vec<(TokenKind, String, &'static str, TokenScope)> = Vec::new();

    let slots: [(TokenKind, Option<String>, &'static str, TokenScope); 3] = [
        (
            TokenKind::Notes,
            config.local_api_notes_token.take(),
            "Notes token (before 3.3.7)",
            TokenScope::Notes,
        ),
        (
            TokenKind::Secrets,
            config.local_api_secrets_token.take(),
            "Secrets token (before 3.3.7)",
            TokenScope::Secrets,
        ),
        (
            TokenKind::Legacy,
            config.local_api_token.take(),
            "Legacy token (before 3.3.7)",
            TokenScope::Secrets,
        ),
    ];
    for (kind, from_config, name, scope) in slots {
        // The keychain copy wins when both exist: it is the one the API used.
        let from_keychain = match &vault_id {
            Some(id) => match token_store::load(id, kind) {
                Ok(Some(token)) => Some(token.to_string()),
                Ok(None) => None,
                Err(e) => {
                    log::warn!(
                        "[clients] keychain lookup for {kind:?} failed during migration: {e}"
                    );
                    None
                }
            },
            None => None,
        };
        let token = from_keychain.or(from_config).filter(|t| !t.is_empty());
        if let Some(token) = token {
            pending.push((kind, token, name, scope));
        }
    }
    if pending.is_empty() {
        return Ok(0);
    }
    let moved = pending.len();
    with_registry(vault_dir, |registry| {
        for (_, token, name, scope) in &pending {
            registry
                .clients
                .push(record(name, *scope, token, &[], None));
        }
        Ok(())
    })?;
    // Only after the hashes are safely written is the plaintext removed.
    if let Some(id) = &vault_id {
        for (kind, _, _, _) in &pending {
            if let Err(e) = token_store::delete(id, *kind) {
                log::warn!(
                    "[clients] could not remove the migrated {kind:?} token from the keychain: {e}"
                );
            }
        }
    }
    Ok(moved)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_minted_token_is_found_by_hash_and_never_stored_in_clear() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        let minted = create(vault, "Claude Code on test", TokenScope::Notes, &[]).unwrap();
        assert!(minted.token.starts_with("clsn_"));

        let registry = load(vault).unwrap();
        let found = registry
            .find(&minted.token)
            .expect("token must authenticate");
        assert_eq!(found.id, minted.client.id);
        assert_eq!(found.scope, TokenScope::Notes);
        assert_eq!(found.name, "Claude Code on test");
        assert!(found.hint.starts_with("clsn_…"));
        assert_eq!(found.hint.len(), "clsn_…".len() + 4);

        let on_disk = std::fs::read_to_string(registry_path(vault)).unwrap();
        assert!(
            !on_disk.contains(minted.token.as_str()),
            "plaintext token on disk"
        );
        assert!(on_disk.contains(&hash_token(&minted.token)));
    }

    #[test]
    fn wrong_tokens_are_rejected_and_revocation_is_immediate() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        let a = create(vault, "a", TokenScope::Secrets, &[]).unwrap();
        let b = create(vault, "b", TokenScope::Notes, &[]).unwrap();

        let registry = load(vault).unwrap();
        assert!(registry.find("clss_not_a_token").is_none());
        assert!(registry.find("").is_none());
        assert!(
            registry.find(&a.token[..a.token.len() - 1]).is_none(),
            "truncated token"
        );

        crate::internal::approval_grants::add(
            vault,
            crate::internal::approval_grants::Grant {
                client_id: a.client.id.clone(),

                client_name: a.client.name.clone(),

                target: "credentials/aws.md".to_string(),

                granted_at: chrono::Utc::now(),
            },
        )
        .unwrap();

        assert!(revoke(vault, &a.client.id).unwrap());
        assert!(
            !revoke(vault, &a.client.id).unwrap(),
            "second revoke finds nothing"
        );

        assert!(
            crate::internal::approval_grants::list(vault).is_empty(),
            "a revoked client's standing approvals must go with it"
        );
        let registry = load(vault).unwrap();
        assert!(
            registry.find(&a.token).is_none(),
            "revoked token still authenticates"
        );
        assert!(
            registry.find(&b.token).is_some(),
            "revoking one client must not touch another"
        );
        assert_eq!(list(vault).unwrap().len(), 1);
    }

    #[test]
    fn names_are_validated() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        assert!(create(vault, "   ", TokenScope::Notes, &[]).is_err());
        assert!(create(vault, "bad\nname", TokenScope::Notes, &[]).is_err());
        assert!(create(vault, &"x".repeat(MAX_NAME_LEN + 1), TokenScope::Notes, &[]).is_err());
        let ok = create(vault, "  trimmed  ", TokenScope::Notes, &[]).unwrap();
        assert_eq!(ok.client.name, "trimmed");
    }

    #[test]
    fn concurrent_creates_do_not_lose_each_other() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path().to_path_buf();
        let handles: Vec<_> = (0..8)
            .map(|i| {
                let vault = vault.clone();
                std::thread::spawn(move || {
                    create(&vault, &format!("client {i}"), TokenScope::Notes, &[]).unwrap()
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(
            list(&vault).unwrap().len(),
            8,
            "a write was lost under contention"
        );
    }

    #[test]
    fn a_missing_registry_means_no_clients_and_a_corrupt_one_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        assert!(load(vault).unwrap().clients.is_empty());
        std::fs::create_dir_all(vault.join(".securenotes")).unwrap();
        std::fs::write(registry_path(vault), "{ not json").unwrap();
        assert!(
            load(vault).is_err(),
            "a corrupt registry must fail closed, not read as empty"
        );
    }

    #[test]
    fn migration_moves_plaintext_slots_into_hashed_records_and_clears_them() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        // No vault_id: the keychain is never consulted, so this exercises the
        // config path without touching the real keychain of whoever runs it.
        let mut config = VaultConfig {
            vault_id: None,
            local_api_notes_token: Some("clsn_oldnotes".to_string()),
            local_api_secrets_token: Some("clss_oldsecrets".to_string()),
            local_api_token: Some("clsp_oldlegacy".to_string()),
            ..VaultConfig::default()
        };
        assert_eq!(migrate_from_slots(vault, &mut config).unwrap(), 3);
        assert!(config.local_api_notes_token.is_none());
        assert!(config.local_api_secrets_token.is_none());
        assert!(config.local_api_token.is_none());

        let registry = load(vault).unwrap();
        assert_eq!(
            registry.find("clsn_oldnotes").unwrap().scope,
            TokenScope::Notes
        );
        assert_eq!(
            registry.find("clss_oldsecrets").unwrap().scope,
            TokenScope::Secrets
        );
        assert_eq!(
            registry.find("clsp_oldlegacy").unwrap().scope,
            TokenScope::Secrets
        );
        let on_disk = std::fs::read_to_string(registry_path(vault)).unwrap();
        assert!(!on_disk.contains("oldnotes") && !on_disk.contains("oldsecrets"));

        // Idempotent.
        assert_eq!(migrate_from_slots(vault, &mut config).unwrap(), 0);
        assert_eq!(list(vault).unwrap().len(), 3);
    }

    #[test]
    fn empty_slots_are_not_tokens() {
        let dir = tempfile::tempdir().unwrap();
        let mut config = VaultConfig {
            vault_id: None,
            local_api_notes_token: Some(String::new()),
            ..VaultConfig::default()
        };
        assert_eq!(migrate_from_slots(dir.path(), &mut config).unwrap(), 0);
        assert!(load(dir.path()).unwrap().clients.is_empty());
    }

    #[test]
    fn registry_survives_a_round_trip_and_tolerates_a_missing_version() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        let minted = create(vault, "x", TokenScope::Secrets, &[]).unwrap();
        // A hand-edited file with no version field still loads.
        let text = std::fs::read_to_string(registry_path(vault)).unwrap();
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        let without_version = serde_json::json!({ "clients": v["clients"] });
        std::fs::write(registry_path(vault), without_version.to_string()).unwrap();
        let registry = load(vault).unwrap();
        assert_eq!(registry.version, 1);
        assert!(registry.find(&minted.token).is_some());
    }

    #[test]
    fn namespaces_are_validated_deduplicated_and_kept_on_the_record() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        let m = create(
            vault,
            "scoped",
            TokenScope::Notes,
            &[
                "claspt".into(),
                " global ".into(),
                "claspt".into(),
                String::new(),
            ],
        )
        .unwrap();
        assert_eq!(m.client.namespaces, ["claspt", "global"]);
        let back = load(vault).unwrap();
        assert_eq!(
            back.find(&m.token).unwrap().namespaces,
            ["claspt", "global"]
        );
        assert!(create(vault, "bad", TokenScope::Notes, &["not valid!".into()]).is_err());
        let open = create(vault, "open", TokenScope::Notes, &[]).unwrap();
        assert!(
            open.client.namespaces.is_empty(),
            "empty means every namespace"
        );
    }
}
