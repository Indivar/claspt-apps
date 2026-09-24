// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Agent secret store — MCP tools for storing and finding credentials.
//!
//! Writes are CONFINED to the `ai/` folder (one page per service, e.g.
//! `ai/aws`), so a misbehaving agent cannot scribble secrets across the vault.
//! Reads/searches are broad: `find_secrets` returns metadata for every secret
//! in the vault (hand-entered, extension, CLI, or agent), never the values.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;

use chrono::{DateTime, Utc};
use serde::Serialize;

use super::error::PageError;
use super::model::Page;
use super::{crud, secret, secret_guard};

/// Serializes credential writes so two concurrent `store_secret` calls for the
/// same service (e.g. an MCP call racing an HTTP call) can't both find "no
/// existing page", each create one, and produce duplicate `ai/<service>` pages
/// or lose one write. Held only for the brief read-modify-write; secret writes
/// are infrequent, so contention is negligible.
static STORE_LOCK: Mutex<()> = Mutex::new(());

/// The single folder agent-written credentials are confined to.
pub const SECRET_ROOT: &str = "ai";

/// Caps to bound resource use from a misbehaving agent.
const MAX_FIELDS: usize = 64;
const MAX_VALUE_LEN: usize = 32 * 1024;

/// Validate a service name used as the page under `ai/`. Alphanumeric, hyphen,
/// underscore, dot; 1-64 chars. The folder is always the fixed `SECRET_ROOT`,
/// so this cannot cause path traversal — it only keeps titles/slugs sane.
fn validate_service(service: &str) -> Result<(), PageError> {
    if service.is_empty() || service.len() > 64 {
        return Err(PageError::InvalidFolderName(
            "service must be 1-64 characters".into(),
        ));
    }
    if !service
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err(PageError::InvalidFolderName(
            "service must be alphanumeric with hyphens, underscores, or dots".into(),
        ));
    }
    if service.contains("..") {
        return Err(PageError::InvalidFolderName(
            "service cannot contain ..".into(),
        ));
    }
    Ok(())
}

/// A secret found by `find_secrets`. Metadata only — never the value.
#[derive(Debug, Serialize)]
pub struct FoundSecret {
    pub label: String,
    /// Whether the block's body is sealed on disk. False means the value is
    /// readable in the file and should be fixed, not used. Present for a
    /// Secrets-scope caller only: the same fact is what `audit_secrets`
    /// withholds from a Notes token, and a list of every unsealed block by
    /// page and label is a targeting aid, so the field is dropped from the
    /// Notes-scope response rather than reported as `false`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encrypted: Option<bool>,
    pub page_title: String,
    pub page_path: String,
    pub folder: String,
    pub tags: Vec<String>,
    pub created_at: DateTime<Utc>,
    /// `claspt://secret/<page>?block=<label>#` — append a field name to get a
    /// reference `claspt run` can resolve. Field names live inside the
    /// encrypted body, so the index cannot list them.
    pub reference_prefix: String,
}

/// Find the existing `ai/<service>` page, if any. Matches on the real path
/// prefix as well as the frontmatter folder, so a page that merely *claims*
/// `folder: ai` in its YAML but physically lives elsewhere is never targeted
/// (keeps updates confined to the real `ai/` directory).
fn find_service_page(vault_dir: &Path, service: &str) -> Result<Option<String>, PageError> {
    let prefix = format!("{SECRET_ROOT}/");
    let found = crud::list_pages(vault_dir)?
        .into_iter()
        .find(|p| {
            p.meta.folder == SECRET_ROOT && p.meta.title == service && p.path.starts_with(&prefix)
        })
        .map(|p| p.path);
    Ok(found)
}

/// Store (or update) a credential as an encrypted secret block in `ai/<service>`.
///
/// Idempotent per `(service, label)`: an existing block with the same label is
/// merged/updated rather than duplicated. `tags` are added to the page (the
/// `service` is always included), provenance is recorded in `custom_meta`
/// (`source: mcp`), and the agent namespace is stamped on the page.
#[allow(clippy::too_many_arguments)]
/// The page a secret was written to, plus anything wrong with its shape.
///
/// The warnings are returned rather than logged so the caller relays them to
/// whoever wrote the secret — an agent reads its own tool response and can
/// correct itself in the same turn, which is the only moment the mistake is
/// cheap to fix.
pub struct StoredSecret {
    pub page: Page,
    /// Reasons the browser extension will not be able to fill this login.
    /// Empty for a correctly shaped login, and for anything that is not a login.
    pub warnings: Vec<String>,
}

pub fn store_secret(
    vault_dir: &Path,
    service: &str,
    label: &str,
    fields: &BTreeMap<String, String>,
    tags: &[String],
    agent_ns: &str,
    master_key: &[u8],
) -> Result<StoredSecret, PageError> {
    validate_service(service)?;
    // Serialize the whole read-modify-write so concurrent stores for the same
    // service don't race into duplicate pages or a lost update. Recover from a
    // poisoned lock (a previous panic) rather than propagating it.
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if label.trim().is_empty() {
        return Err(PageError::InvalidFolderName("label cannot be empty".into()));
    }
    if fields.len() > MAX_FIELDS {
        return Err(PageError::SecretBlock(format!(
            "too many fields (max {MAX_FIELDS})"
        )));
    }
    if fields.values().any(|v| v.len() > MAX_VALUE_LEN) {
        return Err(PageError::SecretBlock(format!(
            "field value too large (max {MAX_VALUE_LEN} bytes)"
        )));
    }

    // Read the current (decrypted) content so we merge into it; empty for a new
    // page. The folder is always the fixed root, so the credential can only land
    // under `ai/`.
    let existing = find_service_page(vault_dir, service)?;
    // The page's storage mode travels with its content so the write below
    // seals it the same way it was found.
    let (current, full_body) = match &existing {
        Some(path) => {
            let page = crud::read_page(vault_dir, path)?;
            (
                secret::decrypt_for_page(page.meta.encrypted, &page.content, master_key)?,
                page.meta.encrypted,
            )
        }
        None => (String::new(), false),
    };

    // patch_block validates the label/values and fails closed BEFORE we create
    // or write anything, so rejected (fence-breaking) input never leaves an
    // empty page behind and never stores a value in plaintext.
    let pairs: Vec<(String, String)> = fields.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    let result = secret::patch_block(&current, label, &pairs, &[], true)
        .map_err(|e| PageError::SecretBlock(e.to_string()))?;
    let encrypted = secret::encrypt_for_page(full_body, &result.content, master_key)?;

    let page_path = match existing {
        Some(path) => path,
        None => crud::create_page(vault_dir, service, SECRET_ROOT, "", false)?.path,
    };

    // Build the tag set: the service is always a tag; add caller tags uniquely.
    let mut new_tags: Vec<String> = vec![service.to_string()];
    for t in tags {
        if !new_tags.contains(t) {
            new_tags.push(t.clone());
        }
    }

    let agent_ns = agent_ns.to_string();
    let updated = crud::update_page_with_meta(vault_dir, &page_path, &encrypted, |meta| {
        for t in &new_tags {
            if !meta.tags.contains(t) {
                meta.tags.push(t.clone());
            }
        }
        meta.agent_ns = Some(agent_ns.clone());
        let mut cm = meta.custom_meta.take().unwrap_or_default();
        cm.insert("source".to_string(), "mcp".to_string());
        meta.custom_meta = Some(cm);
    })?;

    // Check the shape AFTER a successful write. The secret is stored and
    // encrypted either way — a badly named field is a usability fault, not a
    // reason to refuse someone's credential and risk them putting it somewhere
    // worse.
    let pairs: Vec<(String, String)> = fields.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    let warnings = crate::pages::credential_shape::login_fill_issues(&pairs)
        .iter()
        .map(|issue| issue.to_string())
        .collect();

    Ok(StoredSecret {
        page: updated,
        warnings,
    })
}

/// Find secrets across the WHOLE vault (any origin), returning metadata only —
/// never the decrypted values. Optional case-insensitive query matches the
/// label, page title, folder, or any tag.
pub fn find_secrets(vault_dir: &Path, query: Option<&str>) -> Result<Vec<FoundSecret>, PageError> {
    let mut out = Vec::new();
    crud::walk_vault_pages(vault_dir, |rel_path, meta, content| {
        for block in secret::secret_block_states(&content) {
            let reference_prefix = crate::secret_ref::SecretRef {
                page: rel_path.clone(),
                block: Some(block.label.clone()),
                field: "f".to_string(),
            }
            .to_uri();
            let reference_prefix = reference_prefix
                .strip_suffix('f')
                .unwrap_or(&reference_prefix)
                .to_string();
            out.push(FoundSecret {
                reference_prefix,
                label: block.label,
                encrypted: Some(block.encrypted),
                page_title: meta.title.clone(),
                page_path: rel_path.clone(),
                folder: meta.folder.clone(),
                tags: meta.tags.clone(),
                created_at: meta.created_at,
            });
        }
    })?;

    if let Some(q) = query {
        let ql = q.to_lowercase();
        out.retain(|s| {
            s.label.to_lowercase().contains(&ql)
                || s.page_title.to_lowercase().contains(&ql)
                || s.folder.to_lowercase().contains(&ql)
                || s.tags.iter().any(|t| t.to_lowercase().contains(&ql))
        });
    }

    Ok(out)
}

/// One place where secret material sits on disk unprotected.
#[derive(Debug, Clone, Serialize)]
pub struct AuditFinding {
    pub page_path: String,
    pub page_title: String,
    /// `plaintext-secret-block` for a block whose body is not sealed, otherwise
    /// the pattern name from [`secret_guard`] for a value found in note text.
    pub kind: String,
    /// The block label, for block findings.
    pub label: Option<String>,
    /// The 1-based line, for note-text findings.
    pub line: Option<usize>,
}

/// Walk the whole vault and report every secret that is not encrypted: blocks
/// whose body is plaintext, and recognisable keys or tokens in ordinary note
/// text. Values are never included. Full-body encrypted pages are skipped,
/// since nothing in them is readable.
pub fn audit_plaintext_secrets(vault_dir: &Path) -> Result<Vec<AuditFinding>, PageError> {
    let mut out = Vec::new();
    crud::walk_vault_pages(vault_dir, |rel_path, meta, content| {
        if meta.encrypted {
            return;
        }
        for block in secret::secret_block_states(&content) {
            if !block.encrypted && !block.empty {
                out.push(AuditFinding {
                    page_path: rel_path.clone(),
                    page_title: meta.title.clone(),
                    kind: "plaintext-secret-block".to_string(),
                    label: Some(block.label),
                    line: None,
                });
            }
        }
        for found in secret_guard::find_plaintext_secrets(&content) {
            out.push(AuditFinding {
                page_path: rel_path.clone(),
                page_title: meta.title.clone(),
                kind: found.kind.to_string(),
                label: None,
                line: Some(found.line),
            });
        }
    })?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> [u8; 32] {
        [9u8; 32]
    }

    fn fields(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn store_is_confined_and_encrypted() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        let f = fields(&[
            ("API Key", "sk-secret-123"),
            ("Endpoint", "https://api.aws"),
        ]);

        let page = store_secret(
            vault,
            "aws",
            "Prod key",
            &f,
            &["api-key".into()],
            "claude",
            &key(),
        )
        .unwrap();
        let page = page.page;

        // Confined to ai/, tagged with the service, provenance stamped.
        assert_eq!(page.meta.folder, "ai");
        assert!(page.meta.tags.contains(&"aws".to_string()));
        assert!(page.meta.tags.contains(&"api-key".to_string()));
        assert_eq!(
            page.meta
                .custom_meta
                .as_ref()
                .unwrap()
                .get("source")
                .unwrap(),
            "mcp"
        );

        // On-disk content is encrypted (no plaintext secret value).
        let raw = std::fs::read_to_string(vault.join(&page.path)).unwrap();
        assert!(
            raw.contains("enc:v1:"),
            "secret value must be encrypted at rest"
        );
        assert!(
            !raw.contains("sk-secret-123"),
            "plaintext value must not be on disk"
        );
    }

    #[test]
    fn store_dedups_same_label() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();

        store_secret(
            vault,
            "aws",
            "Prod key",
            &fields(&[("API Key", "v1")]),
            &[],
            "a",
            &key(),
        )
        .unwrap();
        store_secret(
            vault,
            "aws",
            "Prod key",
            &fields(&[("API Key", "v2")]),
            &[],
            "a",
            &key(),
        )
        .unwrap();

        // Same service+label updates in place — one page, one block label.
        let found = find_secrets(vault, Some("aws")).unwrap();
        let prod = found.iter().filter(|s| s.label == "Prod key").count();
        assert_eq!(prod, 1, "same (service,label) must not duplicate");
    }

    #[test]
    fn find_returns_metadata_not_values() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        store_secret(
            vault,
            "stripe",
            "Live key",
            &fields(&[("API Key", "sk-live-xyz")]),
            &[],
            "a",
            &key(),
        )
        .unwrap();

        let all = find_secrets(vault, None).unwrap();
        assert!(all
            .iter()
            .any(|s| s.label == "Live key" && s.tags.contains(&"stripe".to_string())));
        // The value is never part of the metadata results.
        let json = serde_json::to_string(&all).unwrap();
        assert!(!json.contains("sk-live-xyz"));
    }

    #[test]
    fn store_rejects_fence_injection_and_never_leaks_plaintext() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();

        // Newline in the label must be rejected (would split the open fence).
        let r1 = store_secret(
            vault,
            "aws",
            "Prod\nkey",
            &fields(&[("API Key", "sk-live-INJECT")]),
            &[],
            "a",
            &key(),
        );
        assert!(r1.is_err(), "newline in label must be rejected");

        // Newline / bare-fence in a field value must be rejected too.
        let r2 = store_secret(
            vault,
            "aws",
            "ok",
            &fields(&[("API Key", "sk\n:::\nLEAKVALUE")]),
            &[],
            "a",
            &key(),
        );
        assert!(r2.is_err(), "newline in value must be rejected");

        // Nothing was written in plaintext anywhere under ai/ (and no empty page
        // was created for the rejected writes).
        let ai = vault.join("ai");
        if ai.exists() {
            for entry in std::fs::read_dir(&ai).unwrap() {
                let raw = std::fs::read_to_string(entry.unwrap().path()).unwrap();
                assert!(
                    !raw.contains("sk-live-INJECT"),
                    "plaintext value leaked to disk"
                );
                assert!(!raw.contains("LEAKVALUE"), "plaintext value leaked to disk");
            }
        }
    }

    #[test]
    fn service_validation_rejects_traversal() {
        assert!(validate_service("../etc").is_err());
        assert!(validate_service("a/b").is_err());
        assert!(validate_service("").is_err());
        assert!(validate_service("aws").is_ok());
        assert!(validate_service("project-x_1.prod").is_ok());
    }

    /// Storing a credential the extension cannot fill must say so.
    ///
    /// Reproduces what an agent did in August 2026: it used the field NAMES as
    /// descriptions and put the whole credential in the value, so every secret
    /// was encrypted correctly and none of them could be autofilled. Nothing
    /// told anyone until someone tried to log in weeks later.
    #[test]
    fn storing_an_unfillable_login_returns_a_warning() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();

        let stored = store_secret(
            vault,
            "example",
            "Tenant and app logins",
            &fields(&[
                ("Note", "three were recorded; verify which is current"),
                ("app.example.com signup A", "alice@example.com / hunter2"),
                ("app.example.com signup B", "alice@example.com / hunter3"),
            ]),
            &["password".into()],
            "claude",
            &key(),
        )
        .unwrap();

        assert!(
            !stored.warnings.is_empty(),
            "an unfillable login was stored with no warning"
        );
        let joined = stored.warnings.join(" ");
        assert!(
            joined.contains("2 separate credentials"),
            "the warning should say the block holds more than one login: {joined}"
        );
        assert!(
            joined.contains("username") && joined.contains("password"),
            "the warning should name the fields to use: {joined}"
        );

        // It is still stored, and still encrypted. A badly named field is a
        // usability fault, not a reason to refuse someone's credential.
        let raw = std::fs::read_to_string(vault.join(&stored.page.path)).unwrap();
        assert!(raw.contains("enc:v1:"));
        assert!(!raw.contains("hunter2"));
    }

    /// A correctly shaped login is stored silently — a warning that fires on
    /// good input teaches people to ignore warnings.
    #[test]
    fn storing_a_well_formed_login_returns_no_warning() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();

        let stored = store_secret(
            vault,
            "example",
            "App login",
            &fields(&[
                ("username", "alice@example.com"),
                ("password", "hunter2"),
                ("url", "https://app.example.com"),
            ]),
            &[],
            "claude",
            &key(),
        )
        .unwrap();

        assert!(
            stored.warnings.is_empty(),
            "a correctly shaped login should store silently: {:?}",
            stored.warnings
        );
    }

    /// An API key is not a login and must not be nagged about.
    #[test]
    fn storing_a_non_login_secret_returns_no_warning() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();

        let stored = store_secret(
            vault,
            "aws",
            "Prod key",
            &fields(&[("API Key", "sk-live-abc"), ("Region", "us-east-1")]),
            &[],
            "claude",
            &key(),
        )
        .unwrap();

        assert!(stored.warnings.is_empty(), "{:?}", stored.warnings);
    }

    #[test]
    fn find_secrets_reports_encryption_state_per_block() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        std::fs::create_dir_all(vault.join("general")).unwrap();
        crud::create_page(
            vault,
            "Mixed",
            "general",
            ":::secret[sealed]\nenc:v1:AAAA\n:::\n:::secret[leaked]\npassword: hunter2\n:::",
            false,
        )
        .unwrap();
        let mut found = find_secrets(vault, None).unwrap();
        found.sort_by(|a, b| a.label.cmp(&b.label));
        let summary: Vec<(&str, Option<bool>)> = found
            .iter()
            .map(|f| (f.label.as_str(), f.encrypted))
            .collect();
        assert_eq!(
            summary,
            vec![("leaked", Some(false)), ("sealed", Some(true))]
        );
    }

    #[test]
    fn audit_lists_plaintext_blocks_and_loose_keys_but_not_sealed_ones() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        std::fs::create_dir_all(vault.join("general")).unwrap();
        crud::create_page(
            vault,
            "Clean",
            "general",
            "notes\n:::secret[ok]\nenc:v1:AAAA\n:::",
            false,
        )
        .unwrap();
        crud::create_page(
            vault,
            "Scratch",
            "general",
            "deploy with AKIAIOSFODNN7EXAMPLE\n:::secret[stripe]\nkey: sk_test_4eC39HqLyjWDarjtT1zdp7dc\n:::",
            false,
        )
        .unwrap();
        let mut findings = audit_plaintext_secrets(vault).unwrap();
        findings.sort_by(|a, b| a.kind.cmp(&b.kind));
        assert_eq!(findings.len(), 2, "{findings:?}");
        assert_eq!(findings[0].kind, "aws-access-key");
        assert_eq!(findings[0].line, Some(1));
        assert_eq!(findings[0].page_title, "Scratch");
        assert_eq!(findings[1].kind, "plaintext-secret-block");
        assert_eq!(findings[1].label.as_deref(), Some("stripe"));
        let rendered = format!("{findings:?}");
        assert!(
            !rendered.contains("4eC39HqLyjWDarjtT1zdp7dc"),
            "findings must never carry values"
        );
    }
}
