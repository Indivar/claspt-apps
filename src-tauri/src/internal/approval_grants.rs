// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Standing approvals: "always allow this client to read this page".
//!
//! Under `secret_access_mode = "approve"` every secrets-scope request raises a
//! prompt. The only way to silence it used to be "remember for this session",
//! a single vault-wide switch that approved every client for every secret
//! until lock (ADR 0001). Now that requests carry a client identity, a grant
//! can be as narrow as it should be: one client, one page, kept until the
//! user revokes it in Settings. ADR 0003 records the change.
//!
//! Grants live in `.securenotes/internal/approval-grants.json`, owner-only and
//! never synced, because they name clients that exist only on this device.
//! Revoking a client removes its grants with it.

use std::path::Path;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::store::InternalStore;

const FILE: &str = "approval-grants.json";

/// One standing approval.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Grant {
    pub client_id: String,
    /// The name at the time of the grant, for display; the id is the key.
    pub client_name: String,
    /// What the grant covers: a page path for page and secret reads, otherwise
    /// the request path. See `local_api::approval::grant_target_for`.
    pub target: String,
    pub granted_at: DateTime<Utc>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct GrantFile {
    grants: Vec<Grant>,
}

/// Every standing approval, oldest first.
pub fn list(vault_dir: &Path) -> Vec<Grant> {
    InternalStore::read::<GrantFile>(vault_dir, FILE).grants
}

/// Whether `client_id` may read `target` without a prompt.
pub fn is_granted(vault_dir: &Path, client_id: &str, target: &str) -> bool {
    list(vault_dir)
        .iter()
        .any(|g| g.client_id == client_id && g.target == target)
}

/// Record a grant. Granting the same pair twice keeps one record.
pub fn add(vault_dir: &Path, grant: Grant) -> std::io::Result<()> {
    let mut file = InternalStore::read::<GrantFile>(vault_dir, FILE);
    file.grants
        .retain(|g| !(g.client_id == grant.client_id && g.target == grant.target));
    file.grants.push(grant);
    InternalStore::write(vault_dir, FILE, &file)
}

/// Remove one grant. Returns whether one was there.
pub fn revoke(vault_dir: &Path, client_id: &str, target: &str) -> std::io::Result<bool> {
    let mut file = InternalStore::read::<GrantFile>(vault_dir, FILE);
    let before = file.grants.len();
    file.grants
        .retain(|g| !(g.client_id == client_id && g.target == target));
    let removed = file.grants.len() != before;
    if removed {
        InternalStore::write(vault_dir, FILE, &file)?;
    }
    Ok(removed)
}

/// Remove every grant a client holds, for when the client itself is revoked.
pub fn revoke_all_for_client(vault_dir: &Path, client_id: &str) -> std::io::Result<usize> {
    let mut file = InternalStore::read::<GrantFile>(vault_dir, FILE);
    let before = file.grants.len();
    file.grants.retain(|g| g.client_id != client_id);
    let removed = before - file.grants.len();
    if removed > 0 {
        InternalStore::write(vault_dir, FILE, &file)?;
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grant(client: &str, target: &str) -> Grant {
        Grant {
            client_id: client.to_string(),
            client_name: format!("{client} name"),
            target: target.to_string(),
            granted_at: Utc::now(),
        }
    }

    #[test]
    fn a_grant_is_exact_to_client_and_target() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        assert!(!is_granted(vault, "a", "credentials/aws.md"));
        add(vault, grant("a", "credentials/aws.md")).unwrap();
        assert!(is_granted(vault, "a", "credentials/aws.md"));
        assert!(!is_granted(vault, "a", "credentials/gcp.md"), "other page");
        assert!(
            !is_granted(vault, "b", "credentials/aws.md"),
            "other client"
        );
    }

    #[test]
    fn granting_twice_keeps_one_record_and_revoke_is_exact() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        add(vault, grant("a", "p")).unwrap();
        add(vault, grant("a", "p")).unwrap();
        add(vault, grant("a", "q")).unwrap();
        assert_eq!(list(vault).len(), 2);
        assert!(revoke(vault, "a", "p").unwrap());
        assert!(!revoke(vault, "a", "p").unwrap());
        assert!(!is_granted(vault, "a", "p"));
        assert!(is_granted(vault, "a", "q"));
    }

    #[test]
    fn revoking_a_client_removes_all_its_grants_and_nobody_elses() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        add(vault, grant("a", "p")).unwrap();
        add(vault, grant("a", "q")).unwrap();
        add(vault, grant("b", "p")).unwrap();
        assert_eq!(revoke_all_for_client(vault, "a").unwrap(), 2);
        assert_eq!(revoke_all_for_client(vault, "a").unwrap(), 0);
        assert_eq!(list(vault).len(), 1);
        assert!(is_granted(vault, "b", "p"));
    }
}
