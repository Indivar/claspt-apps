// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Passkeys kept in the vault: one page per relying party in the `passkeys`
//! folder, one secret block per credential. The block holds the private
//! key, so it is encrypted like any secret; the label carries the account
//! name so the page reads like the rest of the vault. `url_match: never`
//! keeps a passkey block out of the password picker and the rotation
//! reminders, which are for passwords.

use std::path::Path;

use chrono::Utc;
use p256::ecdsa::SigningKey;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use super::crud;
use super::error::PageError;
use super::secret;
use crate::webauthn::{self, b64url, from_b64url};

pub const FOLDER: &str = "passkeys";
pub const TAG: &str = "passkey";
pub const TYPE_FIELD_VALUE: &str = "passkey";

/// A credential's public description: what a picker or `find_secrets`
/// style listing may show. Never the key.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PasskeySummary {
    pub page_path: String,
    pub label: String,
    pub rp_id: String,
    pub rp_name: String,
    pub credential_id: String,
    pub user_name: String,
    pub user_display_name: String,
    pub created: String,
    pub last_used: Option<String>,
}

struct Record {
    summary: PasskeySummary,
    user_id: Vec<u8>,
    private_key: Zeroizing<Vec<u8>>,
}

/// The relying party and user as the page sent them.
#[derive(Debug, Clone, Deserialize)]
pub struct RelyingParty {
    pub id: String,
    #[serde(default)]
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct User {
    /// base64url user handle.
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub display_name: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RegisterRequest {
    pub origin: String,
    #[serde(default)]
    pub cross_origin: bool,
    pub rp: RelyingParty,
    pub user: User,
    /// base64url challenge.
    pub challenge: String,
    /// COSE algorithms the RP accepts; must include -7.
    #[serde(default)]
    pub pub_key_cred_params: Vec<i64>,
    /// base64url credential ids the RP already has for this user.
    #[serde(default)]
    pub exclude_credentials: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AuthenticateRequest {
    pub origin: String,
    #[serde(default)]
    pub cross_origin: bool,
    pub rp_id: String,
    pub challenge: String,
    /// base64url credential ids; empty means any credential for the RP.
    #[serde(default)]
    pub allow_credentials: Vec<String>,
}

fn field<'a>(fields: &'a [(String, String)], name: &str) -> Option<&'a str> {
    fields
        .iter()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.as_str())
}

/// Pages for one relying party: in the folder, titled with the rp id.
fn rp_pages(vault_dir: &Path, rp_id: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let _ = crud::walk_vault_pages(vault_dir, |rel_path, meta, content| {
        if meta.folder == FOLDER && meta.title.eq_ignore_ascii_case(rp_id) {
            out.push((rel_path, content));
        }
    });
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

fn records(vault_dir: &Path, master_key: &[u8], rp_id: &str) -> Result<Vec<Record>, PageError> {
    let mut out = Vec::new();
    for (page_path, content) in rp_pages(vault_dir, rp_id) {
        let decrypted = secret::decrypt_secrets(&content, master_key)?;
        for (label, fields) in secret::list_blocks(&decrypted) {
            if field(&fields, "type") != Some(TYPE_FIELD_VALUE) {
                continue;
            }
            let (Some(credential_id), Some(private_key), Some(user_id)) = (
                field(&fields, "credential_id"),
                field(&fields, "private_key"),
                field(&fields, "user_id"),
            ) else {
                continue;
            };
            let (Ok(private_key), Ok(user_id)) = (from_b64url(private_key), from_b64url(user_id))
            else {
                continue;
            };
            out.push(Record {
                summary: PasskeySummary {
                    page_path: page_path.clone(),
                    label,
                    rp_id: field(&fields, "rp_id").unwrap_or(rp_id).to_string(),
                    rp_name: field(&fields, "rp_name").unwrap_or("").to_string(),
                    credential_id: credential_id.to_string(),
                    user_name: field(&fields, "user_name").unwrap_or("").to_string(),
                    user_display_name: field(&fields, "user_display_name")
                        .unwrap_or("")
                        .to_string(),
                    created: field(&fields, "created").unwrap_or("").to_string(),
                    last_used: field(&fields, "last_used").map(str::to_string),
                },
                user_id,
                private_key: Zeroizing::new(private_key),
            });
        }
    }
    Ok(out)
}

/// The credentials stored for a relying party, without keys.
pub fn list(
    vault_dir: &Path,
    master_key: &[u8],
    rp_id: &str,
) -> Result<Vec<PasskeySummary>, PageError> {
    Ok(records(vault_dir, master_key, rp_id)?
        .into_iter()
        .map(|r| r.summary)
        .collect())
}

/// Every passkey in the vault, for the management screen.
///
/// `list` answers "which credentials may this site offer", so it needs an
/// `rp_id` and is called during a sign-in. A person asking "what passkeys do
/// I have" has no rp_id to give, which is why that question could not be
/// asked at all before this existed.
///
/// Pages are read one at a time and a page that will not decrypt is skipped
/// rather than failing the listing: one damaged page must not hide every
/// other passkey the person owns.
pub fn list_all(vault_dir: &Path, master_key: &[u8]) -> Result<Vec<PasskeySummary>, PageError> {
    let mut pages = Vec::new();
    let _ = crud::walk_vault_pages(vault_dir, |rel_path, meta, content| {
        if meta.folder == FOLDER {
            pages.push((rel_path, content));
        }
    });
    pages.sort_by(|a, b| a.0.cmp(&b.0));

    let mut out = Vec::new();
    for (page_path, content) in pages {
        let Ok(decrypted) = secret::decrypt_secrets(&content, master_key) else {
            continue;
        };
        for (label, fields) in secret::list_blocks(&decrypted) {
            if field(&fields, "type") != Some(TYPE_FIELD_VALUE) {
                continue;
            }
            let Some(credential_id) = field(&fields, "credential_id") else {
                continue;
            };
            out.push(PasskeySummary {
                page_path: page_path.clone(),
                label: label.clone(),
                rp_id: field(&fields, "rp_id").unwrap_or("").to_string(),
                rp_name: field(&fields, "rp_name").unwrap_or("").to_string(),
                credential_id: credential_id.to_string(),
                user_name: field(&fields, "user_name").unwrap_or("").to_string(),
                user_display_name: field(&fields, "user_display_name")
                    .unwrap_or("")
                    .to_string(),
                created: field(&fields, "created").unwrap_or("").to_string(),
                last_used: field(&fields, "last_used").map(str::to_string),
            });
        }
    }
    Ok(out)
}

/// Remove one passkey.
///
/// Keyed on the credential id rather than the block label because two
/// accounts on one site can carry the same label, and deleting a key is not
/// recoverable: the site will keep offering a credential that no longer
/// exists here, and the person has to re-register. Matching on the id means
/// the block deleted is the block shown.
pub fn delete(
    vault_dir: &Path,
    master_key: &[u8],
    page_path: &str,
    credential_id: &str,
) -> Result<(), PageError> {
    let page = crud::read_page(vault_dir, page_path)?;
    let decrypted = secret::decrypt_for_page(page.meta.encrypted, &page.content, master_key)?;

    let label = secret::list_blocks(&decrypted)
        .into_iter()
        .find(|(_, fields)| {
            field(fields, "type") == Some(TYPE_FIELD_VALUE)
                && field(fields, "credential_id") == Some(credential_id)
        })
        .map(|(label, _)| label)
        .ok_or_else(|| {
            PageError::SecretBlock(format!("no passkey with credential id {credential_id}"))
        })?;

    let result = secret::delete_block(&decrypted, &label)
        .map_err(|e| PageError::SecretBlock(format!("{e:?}")))?;
    let encrypted = secret::encrypt_for_page(page.meta.encrypted, &result.content, master_key)?;
    crud::update_page(vault_dir, page_path, &encrypted)?;
    Ok(())
}

fn write_block(
    vault_dir: &Path,
    master_key: &[u8],
    rp_id: &str,
    label: &str,
    fields: &[(String, String)],
) -> Result<String, PageError> {
    let (page_path, content) = match rp_pages(vault_dir, rp_id).into_iter().next() {
        Some(found) => found,
        None => {
            let page = crud::create_page(vault_dir, rp_id, FOLDER, "", false)?;
            (page.path, String::new())
        }
    };
    // The page may have been switched to full-body encryption by hand.
    let full_body = crud::read_page(vault_dir, &page_path)
        .map(|p| p.meta.encrypted)
        .unwrap_or(false);
    let decrypted = secret::decrypt_for_page(full_body, &content, master_key)?;
    let patched = secret::patch_block(&decrypted, label, fields, &[], true)
        .map_err(|e| PageError::SecretBlock(format!("{e:?}")))?;
    let encrypted = secret::encrypt_for_page(full_body, &patched.content, master_key)?;
    crud::update_page_with_meta(vault_dir, &page_path, &encrypted, |meta| {
        if !meta.tags.iter().any(|t| t == TAG) {
            meta.tags.push(TAG.to_string());
        }
    })?;
    Ok(page_path)
}

/// Create a passkey for the request and store it. Refuses when the RP
/// already has one of the excluded credentials here, when the origin does
/// not belong to the RP, or when the RP will not take ES256.
pub fn register(
    vault_dir: &Path,
    master_key: &[u8],
    req: &RegisterRequest,
) -> Result<webauthn::Registration, PageError> {
    if !webauthn::origin_allowed(&req.origin, &req.rp.id) {
        return Err(PageError::SecretBlock(format!(
            "origin {} is not within relying party {}",
            req.origin, req.rp.id
        )));
    }
    if !req.pub_key_cred_params.is_empty()
        && !req.pub_key_cred_params.contains(&webauthn::COSE_ES256)
    {
        return Err(PageError::SecretBlock(
            "relying party does not accept ES256 (P-256) credentials".into(),
        ));
    }
    // The handle is stored as sent and returned as sent; it only has to decode.
    from_b64url(&req.user.id).map_err(|e| PageError::SecretBlock(format!("user id: {e}")))?;
    let existing = records(vault_dir, master_key, &req.rp.id)?;
    if existing
        .iter()
        .any(|r| req.exclude_credentials.contains(&r.summary.credential_id))
    {
        return Err(PageError::SecretBlock(
            "a passkey for this account is already in the vault".into(),
        ));
    }
    let signing = SigningKey::random(&mut rand::rngs::OsRng);
    let mut credential_id = [0u8; 16];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut credential_id);
    let registration = webauthn::register(
        &signing,
        &credential_id,
        &req.rp.id,
        &req.challenge,
        &req.origin,
        req.cross_origin,
    )
    .map_err(PageError::SecretBlock)?;

    let who = if req.user.name.is_empty() {
        req.user.display_name.clone()
    } else {
        req.user.name.clone()
    };
    let mut label = format!(
        "{} ({})",
        if who.is_empty() { "passkey" } else { &who },
        req.rp.id
    );
    // Two passkeys for the same account name on one site need distinct labels.
    if existing.iter().any(|r| r.summary.label == label) {
        label = format!("{label} {}", b64url(&credential_id[..4]));
    }
    let private = Zeroizing::new(signing.to_bytes().to_vec());
    let fields = vec![
        ("type".to_string(), TYPE_FIELD_VALUE.to_string()),
        ("rp_id".to_string(), req.rp.id.clone()),
        ("rp_name".to_string(), req.rp.name.clone()),
        ("user_id".to_string(), req.user.id.clone()),
        ("user_name".to_string(), req.user.name.clone()),
        (
            "user_display_name".to_string(),
            req.user.display_name.clone(),
        ),
        ("credential_id".to_string(), b64url(&credential_id)),
        ("private_key".to_string(), b64url(&private)),
        ("algorithm".to_string(), webauthn::COSE_ES256.to_string()),
        ("created".to_string(), Utc::now().to_rfc3339()),
        ("url_match".to_string(), "never".to_string()),
    ];
    write_block(vault_dir, master_key, &req.rp.id, &label, &fields)?;
    Ok(registration)
}

/// Sign a challenge with a stored passkey. With `allow_credentials` empty
/// the RP wants a discoverable credential: exactly one must exist, or the
/// caller has to pick and ask again with the chosen id.
pub fn authenticate(
    vault_dir: &Path,
    master_key: &[u8],
    req: &AuthenticateRequest,
) -> Result<webauthn::Assertion, PageError> {
    if !webauthn::origin_allowed(&req.origin, &req.rp_id) {
        return Err(PageError::SecretBlock(format!(
            "origin {} is not within relying party {}",
            req.origin, req.rp_id
        )));
    }
    let mut candidates: Vec<Record> = records(vault_dir, master_key, &req.rp_id)?
        .into_iter()
        .filter(|r| {
            req.allow_credentials.is_empty()
                || req.allow_credentials.contains(&r.summary.credential_id)
        })
        .collect();
    let record = match candidates.len() {
        0 => {
            return Err(PageError::NotFound(format!(
                "no passkey for {} in the vault",
                req.rp_id
            )))
        }
        1 => candidates.remove(0),
        n => {
            return Err(PageError::SecretBlock(format!(
                "{n} passkeys for {}; choose one and pass its credential id",
                req.rp_id
            )))
        }
    };
    let signing = SigningKey::from_slice(&record.private_key)
        .map_err(|_| PageError::SecretBlock("stored passkey is not a valid P-256 key".into()))?;
    let credential_id = from_b64url(&record.summary.credential_id)
        .map_err(|e| PageError::SecretBlock(format!("credential id: {e}")))?;
    let assertion = webauthn::assert(
        &signing,
        &credential_id,
        &record.user_id,
        &req.rp_id,
        &req.challenge,
        &req.origin,
        req.cross_origin,
    );
    // Last use is worth recording; a failure to record it is not worth
    // failing the login over.
    let _ = write_block(
        vault_dir,
        master_key,
        &req.rp_id,
        &record.summary.label,
        &[("last_used".to_string(), Utc::now().to_rfc3339())],
    );
    Ok(assertion)
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::signature::Verifier;
    use p256::ecdsa::{Signature, VerifyingKey};
    use p256::pkcs8::DecodePublicKey;
    use sha2::{Digest, Sha256};

    fn register_req(user: &str, exclude: Vec<String>) -> RegisterRequest {
        RegisterRequest {
            origin: "https://login.example.com".into(),
            cross_origin: false,
            rp: RelyingParty {
                id: "example.com".into(),
                name: "Example".into(),
            },
            user: User {
                id: b64url(user.as_bytes()),
                name: user.into(),
                display_name: format!("{user} Person"),
            },
            challenge: "Y2hhbGxlbmdl".into(),
            pub_key_cred_params: vec![-7, -257],
            exclude_credentials: exclude,
        }
    }

    fn auth_req(allow: Vec<String>) -> AuthenticateRequest {
        AuthenticateRequest {
            origin: "https://example.com".into(),
            cross_origin: false,
            rp_id: "example.com".into(),
            challenge: "bmV4dA".into(),
            allow_credentials: allow,
        }
    }

    #[test]
    fn passkeys_register_list_and_sign_and_refuse_the_wrong_origin() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        let key = [5u8; 32];
        let reg = register(vault, &key, &register_req("alice", vec![])).unwrap();
        let listed = list(vault, &key, "example.com").unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].user_name, "alice");
        assert_eq!(listed[0].credential_id, reg.credential_id);
        assert_eq!(listed[0].label, "alice (example.com)");
        assert!(listed[0].page_path.starts_with("passkeys/"));
        // The page carries the tag and the block is sealed on disk.
        let page = crud::read_page(vault, &listed[0].page_path).unwrap();
        assert!(page.meta.tags.contains(&TAG.to_string()));
        assert!(page.content.contains("enc:v1:"));
        assert!(!page.content.contains("private_key:"));

        // Excluding the stored credential refuses a duplicate registration.
        let err = register(
            vault,
            &key,
            &register_req("alice", vec![reg.credential_id.clone()]),
        )
        .unwrap_err();
        assert!(err.to_string().contains("already"));
        // Wrong origin, and an RP that rejects ES256.
        let mut bad = register_req("bob", vec![]);
        bad.origin = "https://example.com.evil.net".into();
        assert!(register(vault, &key, &bad).is_err());
        let mut rsa_only = register_req("bob", vec![]);
        rsa_only.pub_key_cred_params = vec![-257];
        assert!(register(vault, &key, &rsa_only).is_err());

        // Sign, and verify with the registered public key.
        let assertion = authenticate(vault, &key, &auth_req(vec![])).unwrap();
        let spki = from_b64url(&reg.public_key).unwrap();
        let verifying = VerifyingKey::from_public_key_der(&spki).unwrap();
        let mut signed = from_b64url(&assertion.authenticator_data).unwrap();
        signed.extend_from_slice(&Sha256::digest(
            from_b64url(&assertion.client_data_json).unwrap(),
        ));
        let sig = Signature::from_der(&from_b64url(&assertion.signature).unwrap()).unwrap();
        assert!(verifying.verify(&signed, &sig).is_ok());
        assert_eq!(from_b64url(&assertion.user_handle).unwrap(), b"alice");
        assert!(list(vault, &key, "example.com").unwrap()[0]
            .last_used
            .is_some());

        let mut wrong = auth_req(vec![]);
        wrong.origin = "http://example.com".into();
        assert!(authenticate(vault, &key, &wrong).is_err());
        assert!(authenticate(vault, &key, &auth_req(vec!["bm9wZQ".into()])).is_err());
        assert!(list(vault, &key, "other.com").unwrap().is_empty());
    }

    #[test]
    fn several_accounts_need_a_choice() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        let key = [5u8; 32];
        let a = register(vault, &key, &register_req("alice", vec![])).unwrap();
        let b = register(vault, &key, &register_req("bob", vec![])).unwrap();
        // Same account twice gets a distinct label rather than a merged block.
        register(vault, &key, &register_req("alice", vec![])).unwrap();
        let listed = list(vault, &key, "example.com").unwrap();
        assert_eq!(listed.len(), 3);
        let labels: std::collections::HashSet<&str> =
            listed.iter().map(|p| p.label.as_str()).collect();
        assert_eq!(labels.len(), 3);
        let err = authenticate(vault, &key, &auth_req(vec![])).unwrap_err();
        assert!(err.to_string().contains("choose"));
        let chosen = authenticate(vault, &key, &auth_req(vec![b.credential_id.clone()])).unwrap();
        assert_eq!(chosen.credential_id, b.credential_id);
        assert_eq!(from_b64url(&chosen.user_handle).unwrap(), b"bob");
        let other = authenticate(
            vault,
            &key,
            &auth_req(vec![a.credential_id.clone(), "x".into()]),
        )
        .unwrap();
        assert_eq!(other.credential_id, a.credential_id);
    }
}
