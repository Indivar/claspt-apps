// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! The authenticator half of WebAuthn, for passkeys kept in the vault.
//!
//! The browser extension is the client: it takes `navigator.credentials`
//! calls from the page and hands the desktop the relying party, user,
//! challenge and origin. This module makes the bytes the page expects back:
//! `clientDataJSON`, authenticator data, a "none" attestation object, and
//! ECDSA P-256 signatures (COSE algorithm -7), which every relying party
//! accepts. Pure functions; storage is in `pages::passkeys`.

use base64::Engine;
use p256::ecdsa::{signature::Signer, Signature, SigningKey, VerifyingKey};
use p256::pkcs8::EncodePublicKey;
use sha2::{Digest, Sha256};

/// COSE algorithm identifier for ECDSA with P-256 and SHA-256.
pub const COSE_ES256: i64 = -7;

const FLAG_USER_PRESENT: u8 = 0x01;
const FLAG_USER_VERIFIED: u8 = 0x04;
const FLAG_BACKUP_ELIGIBLE: u8 = 0x08;
const FLAG_BACKED_UP: u8 = 0x10;
const FLAG_ATTESTED_CREDENTIAL: u8 = 0x40;

pub fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

pub fn from_b64url(text: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(text.trim_end_matches('='))
        .map_err(|_| "not base64url".to_string())
}

/// Whether a page at `origin` may use credentials for `rp_id`: HTTPS (or
/// http on localhost), and the host is the relying party or a subdomain of
/// it. This is the check that keeps a look-alike site from using a passkey
/// registered elsewhere.
pub fn origin_allowed(origin: &str, rp_id: &str) -> bool {
    let Ok(url) = url::Url::parse(origin) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.to_ascii_lowercase();
    let rp_id = rp_id.to_ascii_lowercase();
    let local = host == "localhost" || host.ends_with(".localhost");
    let scheme_ok = url.scheme() == "https" || (url.scheme() == "http" && local);
    if !scheme_ok || rp_id.is_empty() || rp_id.contains('/') {
        return false;
    }
    host == rp_id || host.ends_with(&format!(".{rp_id}"))
}

/// A tiny canonical CBOR encoder: the four types WebAuthn structures use.
#[derive(Debug, Clone)]
pub enum Cbor {
    Uint(u64),
    Neg(i64),
    Bytes(Vec<u8>),
    Text(String),
    Map(Vec<(Cbor, Cbor)>),
}

impl Cbor {
    pub fn int(value: i64) -> Cbor {
        if value >= 0 {
            Cbor::Uint(value as u64)
        } else {
            Cbor::Neg(value)
        }
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::new();
        self.encode_into(&mut out);
        out
    }

    fn head(out: &mut Vec<u8>, major: u8, value: u64) {
        let m = major << 5;
        if value < 24 {
            out.push(m | value as u8);
        } else if value <= 0xff {
            out.push(m | 24);
            out.push(value as u8);
        } else if value <= 0xffff {
            out.push(m | 25);
            out.extend_from_slice(&(value as u16).to_be_bytes());
        } else if value <= 0xffff_ffff {
            out.push(m | 26);
            out.extend_from_slice(&(value as u32).to_be_bytes());
        } else {
            out.push(m | 27);
            out.extend_from_slice(&value.to_be_bytes());
        }
    }

    fn encode_into(&self, out: &mut Vec<u8>) {
        match self {
            Cbor::Uint(v) => Self::head(out, 0, *v),
            Cbor::Neg(v) => Self::head(out, 1, (-1 - *v) as u64),
            Cbor::Bytes(b) => {
                Self::head(out, 2, b.len() as u64);
                out.extend_from_slice(b);
            }
            Cbor::Text(t) => {
                Self::head(out, 3, t.len() as u64);
                out.extend_from_slice(t.as_bytes());
            }
            Cbor::Map(entries) => {
                Self::head(out, 5, entries.len() as u64);
                for (k, v) in entries {
                    k.encode_into(out);
                    v.encode_into(out);
                }
            }
        }
    }
}

/// The COSE_Key for a P-256 public key, in the canonical order RPs expect.
pub fn cose_key(verifying: &VerifyingKey) -> Vec<u8> {
    let point = verifying.to_encoded_point(false);
    let x = point.x().map(|b| b.to_vec()).unwrap_or_default();
    let y = point.y().map(|b| b.to_vec()).unwrap_or_default();
    Cbor::Map(vec![
        (Cbor::int(1), Cbor::int(2)), // kty: EC2
        (Cbor::int(3), Cbor::int(COSE_ES256)),
        (Cbor::int(-1), Cbor::int(1)), // crv: P-256
        (Cbor::int(-2), Cbor::Bytes(x)),
        (Cbor::int(-3), Cbor::Bytes(y)),
    ])
    .encode()
}

fn client_data(kind: &str, challenge_b64url: &str, origin: &str, cross_origin: bool) -> Vec<u8> {
    // Built here and returned verbatim so the hash we sign is over exactly
    // the bytes the page sends the relying party.
    serde_json::json!({
        "type": kind,
        "challenge": challenge_b64url,
        "origin": origin,
        "crossOrigin": cross_origin,
    })
    .to_string()
    .into_bytes()
}

/// Flags for a vault passkey: the user was present and verified (they
/// approved in the app), and the credential is backup-eligible and backed
/// up (it lives in a synced vault), which tells the RP to expect a sign
/// count of zero.
fn base_flags() -> u8 {
    FLAG_USER_PRESENT | FLAG_USER_VERIFIED | FLAG_BACKUP_ELIGIBLE | FLAG_BACKED_UP
}

fn auth_data(rp_id: &str, flags: u8, attested: Option<(&[u8], &[u8])>) -> Vec<u8> {
    let mut out = Vec::with_capacity(37);
    out.extend_from_slice(&Sha256::digest(rp_id.as_bytes()));
    out.push(flags);
    // Sign count stays zero: a synced credential cannot keep a strictly
    // increasing counter across devices, and the backup flags say so.
    out.extend_from_slice(&0u32.to_be_bytes());
    if let Some((credential_id, cose)) = attested {
        out.extend_from_slice(&[0u8; 16]); // AAGUID: none claimed
        out.extend_from_slice(&(credential_id.len() as u16).to_be_bytes());
        out.extend_from_slice(credential_id);
        out.extend_from_slice(cose);
    }
    out
}

/// What the page gets back from `navigator.credentials.create`, all
/// base64url.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Registration {
    pub credential_id: String,
    pub client_data_json: String,
    pub attestation_object: String,
    pub authenticator_data: String,
    /// SubjectPublicKeyInfo DER, for `response.getPublicKey()`.
    pub public_key: String,
    pub public_key_algorithm: i64,
}

/// Make a new P-256 key and the registration response for it.
pub fn register(
    signing: &SigningKey,
    credential_id: &[u8],
    rp_id: &str,
    challenge_b64url: &str,
    origin: &str,
    cross_origin: bool,
) -> Result<Registration, String> {
    let verifying = VerifyingKey::from(signing);
    let cose = cose_key(&verifying);
    let data = auth_data(
        rp_id,
        base_flags() | FLAG_ATTESTED_CREDENTIAL,
        Some((credential_id, &cose)),
    );
    let attestation = Cbor::Map(vec![
        (Cbor::Text("fmt".into()), Cbor::Text("none".into())),
        (Cbor::Text("attStmt".into()), Cbor::Map(Vec::new())),
        (Cbor::Text("authData".into()), Cbor::Bytes(data.clone())),
    ])
    .encode();
    let client = client_data("webauthn.create", challenge_b64url, origin, cross_origin);
    let spki = verifying
        .to_public_key_der()
        .map_err(|e| format!("public key encoding failed: {e}"))?;
    Ok(Registration {
        credential_id: b64url(credential_id),
        client_data_json: b64url(&client),
        attestation_object: b64url(&attestation),
        authenticator_data: b64url(&data),
        public_key: b64url(spki.as_bytes()),
        public_key_algorithm: COSE_ES256,
    })
}

/// What the page gets back from `navigator.credentials.get`, all base64url.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Assertion {
    pub credential_id: String,
    pub client_data_json: String,
    pub authenticator_data: String,
    pub signature: String,
    pub user_handle: String,
}

/// Sign a challenge with an existing key.
pub fn assert(
    signing: &SigningKey,
    credential_id: &[u8],
    user_handle: &[u8],
    rp_id: &str,
    challenge_b64url: &str,
    origin: &str,
    cross_origin: bool,
) -> Assertion {
    let data = auth_data(rp_id, base_flags(), None);
    let client = client_data("webauthn.get", challenge_b64url, origin, cross_origin);
    let mut signed = data.clone();
    signed.extend_from_slice(&Sha256::digest(&client));
    let signature: Signature = signing.sign(&signed);
    Assertion {
        credential_id: b64url(credential_id),
        client_data_json: b64url(&client),
        authenticator_data: b64url(&data),
        signature: b64url(signature.to_der().as_bytes()),
        user_handle: b64url(user_handle),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::signature::Verifier;
    use p256::pkcs8::DecodePublicKey;

    #[test]
    fn cbor_matches_known_encodings() {
        assert_eq!(Cbor::int(1).encode(), [0x01]);
        assert_eq!(Cbor::int(24).encode(), [0x18, 0x18]);
        assert_eq!(Cbor::int(-7).encode(), [0x26]);
        assert_eq!(Cbor::int(-1).encode(), [0x20]);
        assert_eq!(Cbor::int(300).encode(), [0x19, 0x01, 0x2c]);
        assert_eq!(Cbor::Text("fmt".into()).encode(), [0x63, b'f', b'm', b't']);
        assert_eq!(Cbor::Bytes(vec![0; 32]).encode()[..2], [0x58, 0x20]);
        assert_eq!(Cbor::Map(vec![]).encode(), [0xa0]);
        let m = Cbor::Map(vec![(Cbor::Text("a".into()), Cbor::int(1))]).encode();
        assert_eq!(m, [0xa1, 0x61, b'a', 0x01]);
    }

    #[test]
    fn origins_must_be_https_and_within_the_relying_party() {
        assert!(origin_allowed("https://example.com", "example.com"));
        assert!(origin_allowed("https://login.example.com", "example.com"));
        assert!(origin_allowed("https://Example.COM:8443", "example.com"));
        assert!(origin_allowed("http://localhost:3000", "localhost"));
        assert!(!origin_allowed("http://example.com", "example.com"));
        assert!(!origin_allowed(
            "https://example.com.evil.net",
            "example.com"
        ));
        assert!(!origin_allowed("https://notexample.com", "example.com"));
        assert!(!origin_allowed("https://example.com", "login.example.com"));
        assert!(!origin_allowed("not a url", "example.com"));
        assert!(!origin_allowed("https://example.com", ""));
    }

    #[test]
    fn registration_and_assertion_verify_with_the_returned_public_key() {
        let signing = SigningKey::random(&mut rand::rngs::OsRng);
        let credential_id = [7u8; 16];
        let reg = register(
            &signing,
            &credential_id,
            "example.com",
            "Y2hhbGxlbmdl",
            "https://app.example.com",
            false,
        )
        .unwrap();
        let data = from_b64url(&reg.authenticator_data).unwrap();
        assert_eq!(&data[..32], &Sha256::digest(b"example.com")[..]);
        assert_eq!(data[32], 0x5d, "UP|UV|BE|BS|AT");
        assert_eq!(&data[33..37], &[0, 0, 0, 0]);
        assert_eq!(&data[37..53], &[0u8; 16]);
        assert_eq!(&data[53..55], &[0, 16]);
        assert_eq!(&data[55..71], &credential_id);
        let cose = &data[71..];
        assert_eq!(cose[0], 0xa5, "five-entry COSE map");
        assert_eq!(cose[1..4], [0x01, 0x02, 0x03]);
        // The attestation object wraps the same authData under "none".
        let att = from_b64url(&reg.attestation_object).unwrap();
        assert_eq!(att[0], 0xa3);
        assert!(att.windows(4).any(|w| w == b"none"));
        assert!(att.windows(data.len()).any(|w| w == &data[..]));
        let client = from_b64url(&reg.client_data_json).unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&client).unwrap();
        assert_eq!(parsed["type"], "webauthn.create");
        assert_eq!(parsed["challenge"], "Y2hhbGxlbmdl");
        assert_eq!(parsed["origin"], "https://app.example.com");
        let spki = from_b64url(&reg.public_key).unwrap();
        let verifying = VerifyingKey::from_public_key_der(&spki).unwrap();
        assert_eq!(verifying, VerifyingKey::from(&signing));

        let assertion = assert(
            &signing,
            &credential_id,
            b"user-1",
            "example.com",
            "bmV3",
            "https://app.example.com",
            false,
        );
        let auth = from_b64url(&assertion.authenticator_data).unwrap();
        assert_eq!(auth.len(), 37);
        assert_eq!(auth[32], 0x1d, "UP|UV|BE|BS");
        let client = from_b64url(&assertion.client_data_json).unwrap();
        let mut signed = auth.clone();
        signed.extend_from_slice(&Sha256::digest(&client));
        let sig = Signature::from_der(&from_b64url(&assertion.signature).unwrap()).unwrap();
        assert!(verifying.verify(&signed, &sig).is_ok());
        assert_eq!(from_b64url(&assertion.user_handle).unwrap(), b"user-1");
        // A different challenge is a different client hash: the signature must not carry over.
        let other = assert(
            &signing,
            &credential_id,
            b"user-1",
            "example.com",
            "b3RoZXI",
            "https://app.example.com",
            false,
        );
        let mut wrong = auth.clone();
        wrong.extend_from_slice(&Sha256::digest(
            from_b64url(&other.client_data_json).unwrap(),
        ));
        assert!(verifying.verify(&wrong, &sig).is_err());
    }
}
