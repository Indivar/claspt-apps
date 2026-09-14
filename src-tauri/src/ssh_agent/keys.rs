// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Which vault entries are SSH keys, their public halves, and signing.
//!
//! A key lives in a secret block with a `private_key` field, on a page
//! tagged `ssh-key`. The tag is the index: field names sit inside the
//! encrypted body, so without it every page with a secret block would have
//! to be decrypted to find the keys. Block fields are single lines, so the
//! value is the OpenSSH private key with its line breaks removed: the base64
//! body alone, or the whole PEM squashed onto one line; both are accepted,
//! and `claspt ssh add` writes the first. An optional `passphrase` field
//! unlocks an encrypted key; an optional `public_key` field saves deriving
//! the public half.

use std::path::Path;

use base64::Engine;
use ssh_encoding::Encode;
use ssh_key::{Algorithm, HashAlg, PrivateKey, PublicKey, Signature};
use zeroize::Zeroizing;

use super::protocol::{SSH_AGENT_RSA_SHA2_256, SSH_AGENT_RSA_SHA2_512};
use crate::pages::{crud, secret};

pub const KEY_TAG: &str = "ssh-key";
pub const PRIVATE_KEY_FIELD: &str = "private_key";
pub const PUBLIC_KEY_FIELD: &str = "public_key";
pub const PASSPHRASE_FIELD: &str = "passphrase";

/// Where a key lives; enough to find it again and to name it in a prompt.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct KeyRef {
    pub page_path: String,
    pub page_title: String,
    pub label: String,
}

/// A key as the agent lists it: its public half and where it lives.
#[derive(Debug, Clone)]
pub struct Identity {
    pub key: KeyRef,
    pub public: PublicKey,
    /// Wire-format public key, what `ssh` uses to name the key.
    pub blob: Vec<u8>,
    /// Comment shown by `ssh-add -l`.
    pub comment: String,
}

/// Pages tagged as holding SSH keys, with their still-encrypted content.
fn key_pages(vault_dir: &Path) -> Vec<(String, String, String)> {
    let mut out = Vec::new();
    let _ = crud::walk_vault_pages(vault_dir, |rel_path, meta, content| {
        if meta.tags.iter().any(|t| t.eq_ignore_ascii_case(KEY_TAG)) {
            out.push((rel_path, meta.title.clone(), content));
        }
    });
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

fn field<'a>(fields: &'a [(String, String)], name: &str) -> Option<&'a str> {
    fields
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
}

/// The base64 body of a PEM with all whitespace removed, with the markers
/// stripped when present.
fn pem_body(text: &str) -> String {
    let compact: String = text.split_whitespace().collect();
    const OPEN: &str = "PRIVATEKEY-----";
    match (compact.find(OPEN), compact.rfind("-----END")) {
        (Some(start), Some(end)) if start + OPEN.len() <= end => {
            compact[start + OPEN.len()..end].to_string()
        }
        _ => compact,
    }
}

/// The OpenSSH private key behind a field value: a multi-line PEM, the same
/// PEM on one line, or just its base64 body.
pub fn parse_private(text: &str) -> Result<PrivateKey, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(pem_body(text))
        .map_err(|_| "private_key is not an OpenSSH private key (expected its base64 body)")?;
    PrivateKey::from_bytes(&bytes).map_err(|e| format!("not an OpenSSH private key: {e}"))
}

/// The one-line form `claspt ssh add` stores: the PEM body without markers
/// or line breaks. Parsed first, so a body that does not decode is never
/// stored.
pub fn one_line_body(pem: &str) -> Result<String, String> {
    parse_private(pem)?;
    Ok(pem_body(pem))
}

/// Parse and, when needed, decrypt the private key held in a block.
fn private_from_fields(fields: &[(String, String)]) -> Result<PrivateKey, String> {
    let text = field(fields, PRIVATE_KEY_FIELD).ok_or("block has no private_key field")?;
    let key = parse_private(text)?;
    if !key.is_encrypted() {
        return Ok(key);
    }
    let passphrase = Zeroizing::new(
        field(fields, PASSPHRASE_FIELD)
            .ok_or("key is passphrase-protected and the block has no passphrase field")?
            .to_string(),
    );
    key.decrypt(passphrase.as_bytes())
        .map_err(|_| "the passphrase in the block does not unlock this key".to_string())
}

/// The public half of a block's key: the `public_key` field when it parses,
/// else derived from the private key.
fn public_from_fields(fields: &[(String, String)]) -> Result<PublicKey, String> {
    if let Some(text) = field(fields, PUBLIC_KEY_FIELD) {
        if let Ok(public) = PublicKey::from_openssh(text.trim()) {
            return Ok(public);
        }
    }
    let private = private_from_fields(fields)?;
    Ok(private.public_key().clone())
}

/// Every key the agent can offer. Blocks that do not parse are skipped and
/// logged by label, never by content.
pub fn identities(vault_dir: &Path, master_key: &[u8]) -> Vec<Identity> {
    let mut out = Vec::new();
    for (page_path, page_title, content) in key_pages(vault_dir) {
        let Ok(decrypted) = secret::decrypt_secrets(&content, master_key) else {
            log::warn!("[ssh-agent] could not decrypt {page_path}; skipped");
            continue;
        };
        for (label, fields) in secret::list_blocks(&decrypted) {
            if field(&fields, PRIVATE_KEY_FIELD).is_none() {
                continue;
            }
            match public_from_fields(&fields) {
                Ok(public) => {
                    let Ok(blob) = public.to_bytes() else {
                        continue;
                    };
                    out.push(Identity {
                        comment: format!("{label} ({page_title})"),
                        key: KeyRef {
                            page_path: page_path.clone(),
                            page_title: page_title.clone(),
                            label,
                        },
                        public,
                        blob,
                    });
                }
                Err(e) => log::warn!("[ssh-agent] key '{label}' on {page_path} skipped: {e}"),
            }
        }
    }
    out
}

/// The private key for one identity, decrypted for a single use.
pub fn load_private(
    vault_dir: &Path,
    master_key: &[u8],
    key: &KeyRef,
) -> Result<PrivateKey, String> {
    let page = crud::read_page(vault_dir, &key.page_path).map_err(|e| e.to_string())?;
    let decrypted =
        secret::decrypt_secrets(&page.content, master_key).map_err(|e| e.to_string())?;
    let blocks = secret::list_blocks(&decrypted);
    let (_, fields) = blocks
        .into_iter()
        .find(|(l, _)| *l == key.label)
        .ok_or_else(|| format!("no secret block '{}' on {}", key.label, key.page_path))?;
    private_from_fields(&fields)
}

/// An `rsa` private key from the parsed pair. Built here rather than through
/// ssh-key's conversion, which (0.6.7) passes `p` twice instead of `p, q`
/// and so fails validation for every real key.
fn rsa_private(pair: &ssh_key::private::RsaKeypair) -> Result<rsa::RsaPrivateKey, String> {
    let big = |m: &ssh_key::Mpint| {
        rsa::BigUint::try_from(m).map_err(|e| format!("RSA key unusable: {e}"))
    };
    rsa::RsaPrivateKey::from_components(
        big(&pair.public.n)?,
        big(&pair.public.e)?,
        big(&pair.private.d)?,
        vec![big(&pair.private.p)?, big(&pair.private.q)?],
    )
    .map_err(|e| format!("RSA key unusable: {e}"))
}

/// Sign `data` the way `ssh` asked: RSA keys honour the SHA-2 flags (SHA-512
/// when both or neither are set, matching OpenSSH's agent), other algorithms
/// have one signature form. Returns the wire-encoded signature.
pub fn sign(key: &PrivateKey, data: &[u8], flags: u32) -> Result<Vec<u8>, String> {
    use signature::{SignatureEncoding, Signer};
    let signature = match key.key_data() {
        ssh_key::private::KeypairData::Rsa(pair) => {
            let private = rsa_private(pair)?;
            let want_256 =
                flags & SSH_AGENT_RSA_SHA2_256 != 0 && flags & SSH_AGENT_RSA_SHA2_512 == 0;
            let (hash, bytes) = if want_256 {
                let signer = rsa::pkcs1v15::SigningKey::<sha2::Sha256>::new(private);
                let sig: rsa::pkcs1v15::Signature = signer.sign(data);
                (HashAlg::Sha256, sig.to_vec())
            } else {
                let signer = rsa::pkcs1v15::SigningKey::<sha2::Sha512>::new(private);
                let sig: rsa::pkcs1v15::Signature = signer.sign(data);
                (HashAlg::Sha512, sig.to_vec())
            };
            Signature::new(Algorithm::Rsa { hash: Some(hash) }, bytes).map_err(|e| e.to_string())?
        }
        _ => key
            .try_sign(data)
            .map_err(|e| format!("signing failed: {e}"))?,
    };
    let mut wire = Vec::new();
    signature
        .encode(&mut wire)
        .map_err(|e| format!("signature encoding failed: {e}"))?;
    Ok(wire)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pages::agent_secret;
    use ssh_encoding::Decode;
    use ssh_key::LineEnding;
    use std::collections::BTreeMap;

    fn verify(public: &PublicKey, data: &[u8], wire: &[u8]) -> bool {
        let sig = Signature::decode(&mut &wire[..]).unwrap();
        signature::Verifier::verify(public, data, &sig).is_ok()
    }

    fn store_key(
        vault: &Path,
        key: &[u8],
        service: &str,
        label: &str,
        private: &str,
        extra: &[(&str, &str)],
        tags: &[&str],
    ) {
        let mut fields = BTreeMap::from([(PRIVATE_KEY_FIELD.to_string(), private.to_string())]);
        for (k, v) in extra {
            fields.insert(k.to_string(), v.to_string());
        }
        let tags: Vec<String> = tags.iter().map(|t| t.to_string()).collect();
        agent_secret::store_secret(vault, service, label, &fields, &tags, "test", key).unwrap();
    }

    #[test]
    fn private_keys_parse_from_pem_one_line_pem_and_bare_body() {
        let key = PrivateKey::random(&mut rand::rngs::OsRng, Algorithm::Ed25519).unwrap();
        let pem = key.to_openssh(LineEnding::LF).unwrap();
        let body = one_line_body(&pem).unwrap();
        assert!(!body.contains('-') && !body.contains(' '));
        for text in [
            pem.to_string(),
            pem.replace('\n', " "),
            body.clone(),
            format!("  {body}\n"),
        ] {
            let parsed = parse_private(&text).unwrap();
            assert_eq!(parsed.public_key().key_data(), key.public_key().key_data());
        }
        assert!(parse_private("not a key").is_err());
        assert!(parse_private(
            "-----BEGIN OPENSSH PRIVATE KEY----- AAAA -----END OPENSSH PRIVATE KEY-----"
        )
        .is_err());
        assert!(one_line_body("garbage").is_err());
    }

    #[test]
    fn identities_come_from_tagged_pages_only_and_sign_verifiably() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        let master = [9u8; 32];
        let ed = PrivateKey::random(&mut rand::rngs::OsRng, Algorithm::Ed25519).unwrap();
        // Stored the way `claspt ssh add` stores it: the PEM body on one line.
        let ed_body = one_line_body(&ed.to_openssh(LineEnding::LF).unwrap()).unwrap();
        store_key(
            vault,
            &master,
            "deploy",
            "Deploy key",
            &ed_body,
            &[],
            &[KEY_TAG],
        );
        // Same shape, no tag: invisible to the agent.
        store_key(
            vault,
            &master,
            "untagged",
            "Hidden",
            &ed_body,
            &[],
            &["misc"],
        );
        // Passphrase-protected key as a one-line PEM, with the passphrase
        // alongside and a stored public key that must be used as given.
        let ec = PrivateKey::random(
            &mut rand::rngs::OsRng,
            Algorithm::Ecdsa {
                curve: ssh_key::EcdsaCurve::NistP256,
            },
        )
        .unwrap();
        let ec_enc = ec.encrypt(&mut rand::rngs::OsRng, b"open sesame").unwrap();
        let ec_line = ec_enc
            .to_openssh(LineEnding::LF)
            .unwrap()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        let ec_pub = ec.public_key().to_openssh().unwrap();
        store_key(
            vault,
            &master,
            "git",
            "Git key",
            &ec_line,
            &[
                (PASSPHRASE_FIELD, "open sesame"),
                (PUBLIC_KEY_FIELD, &ec_pub),
            ],
            &["SSH-Key", "git"],
        );
        // Wrong passphrase: logged, not offered.
        store_key(
            vault,
            &master,
            "broken",
            "Broken",
            &ec_line,
            &[(PASSPHRASE_FIELD, "wrong")],
            &[KEY_TAG],
        );

        let ids = identities(vault, &master);
        let labels: Vec<&str> = ids.iter().map(|i| i.key.label.as_str()).collect();
        assert_eq!(labels, ["Deploy key", "Git key"]);
        assert_eq!(ids[0].comment, "Deploy key (deploy)");
        assert_eq!(ids[0].blob, ed.public_key().to_bytes().unwrap());
        assert_eq!(ids[1].blob, ec.public_key().to_bytes().unwrap());

        let data = b"session identifier and more";
        let private = load_private(vault, &master, &ids[0].key).unwrap();
        let wire = sign(&private, data, 0).unwrap();
        assert!(verify(&ids[0].public, data, &wire));
        let private = load_private(vault, &master, &ids[1].key).unwrap();
        let wire = sign(&private, data, 0).unwrap();
        assert!(verify(&ids[1].public, data, &wire));
        assert!(!verify(&ids[1].public, b"other data", &wire));
        let missing = KeyRef {
            page_path: ids[0].key.page_path.clone(),
            page_title: String::new(),
            label: "nope".into(),
        };
        assert!(load_private(vault, &master, &missing).is_err());
    }

    #[test]
    fn rsa_signatures_follow_the_requested_hash() {
        // 2048 bits: enough to exercise both hashes without the wait of a
        // 4096-bit key, which is what `random` would make.
        let pair = ssh_key::private::RsaKeypair::random(&mut rand::rngs::OsRng, 2048).unwrap();
        let key = PrivateKey::new(ssh_key::private::KeypairData::Rsa(pair), "test").unwrap();
        let data = b"payload";
        for (flags, expected) in [
            (SSH_AGENT_RSA_SHA2_256, "rsa-sha2-256"),
            (SSH_AGENT_RSA_SHA2_512, "rsa-sha2-512"),
            (0, "rsa-sha2-512"),
            (
                SSH_AGENT_RSA_SHA2_256 | SSH_AGENT_RSA_SHA2_512,
                "rsa-sha2-512",
            ),
        ] {
            let wire = sign(&key, data, flags).unwrap();
            let sig = Signature::decode(&mut &wire[..]).unwrap();
            assert_eq!(sig.algorithm().as_str(), expected, "flags {flags}");
            assert!(verify(key.public_key(), data, &wire));
        }
    }
}
