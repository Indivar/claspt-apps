// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! RFC 6238 time-based one-time passwords over RFC 4226 HOTP.
//!
//! The mobile app used to compute these in JavaScript, with a hand-written
//! SHA-1 and HMAC beside the seed, in a file with no tests. The seed is a
//! long-lived secret and the code is what a person types, so both belong on
//! the same side of the line as every other secret operation: here, on
//! `ring`'s HMAC, with the RFC's own test vectors. The browser extension has
//! WebCrypto for the same job (`shared/src/totp.ts`); a phone does not.

use ring::hmac;

use super::error::CryptoError;

/// The HMAC an authenticator uses. Only these three appear in `otpauth://`
/// URIs; the name is matched as the URI carries it, case-insensitively.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Algorithm {
    Sha1,
    Sha256,
    Sha512,
}

impl Algorithm {
    /// Parse the `algorithm` parameter of an `otpauth://` URI. An absent or
    /// empty value is SHA-1, which is what the URI format defaults to.
    pub fn parse(name: &str) -> Result<Self, CryptoError> {
        match name.trim().to_ascii_uppercase().as_str() {
            "" | "SHA1" | "SHA-1" => Ok(Self::Sha1),
            "SHA256" | "SHA-256" => Ok(Self::Sha256),
            "SHA512" | "SHA-512" => Ok(Self::Sha512),
            other => Err(CryptoError::Encryption(format!(
                "unsupported TOTP algorithm: {other}"
            ))),
        }
    }

    fn hmac(self) -> hmac::Algorithm {
        match self {
            // SHA-1 is what nearly every site issues; HOTP's security rests on
            // the HMAC construction, not on SHA-1's collision resistance.
            Self::Sha1 => hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY,
            Self::Sha256 => hmac::HMAC_SHA256,
            Self::Sha512 => hmac::HMAC_SHA512,
        }
    }
}

/// Decode an RFC 4648 base32 secret as authenticator apps write it: upper or
/// lower case, spaces and dashes allowed, padding optional.
pub fn base32_decode(input: &str) -> Result<Vec<u8>, CryptoError> {
    const ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let mut out = Vec::with_capacity(input.len() * 5 / 8);
    let mut buffer: u32 = 0;
    let mut bits = 0;
    for c in input.bytes() {
        if c == b' ' || c == b'-' || c == b'=' {
            continue;
        }
        let value = ALPHABET
            .iter()
            .position(|&a| a == c.to_ascii_uppercase())
            .ok_or_else(|| CryptoError::Encryption("invalid base32 character".into()))?;
        buffer = (buffer << 5) | value as u32;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    if out.is_empty() {
        return Err(CryptoError::Encryption("empty TOTP secret".into()));
    }
    Ok(out)
}

/// RFC 4226 HOTP: the `digits`-long code for `counter` under `key`.
pub fn hotp(
    key: &[u8],
    algorithm: Algorithm,
    counter: u64,
    digits: u32,
) -> Result<String, CryptoError> {
    if !(6..=8).contains(&digits) {
        return Err(CryptoError::Encryption(format!(
            "TOTP digits must be 6 to 8, got {digits}"
        )));
    }
    let tag = hmac::sign(
        &hmac::Key::new(algorithm.hmac(), key),
        &counter.to_be_bytes(),
    );
    let mac = tag.as_ref();
    let offset = (mac[mac.len() - 1] & 0x0f) as usize;
    let binary = ((mac[offset] & 0x7f) as u32) << 24
        | (mac[offset + 1] as u32) << 16
        | (mac[offset + 2] as u32) << 8
        | mac[offset + 3] as u32;
    let code = binary % 10u32.pow(digits);
    Ok(format!("{code:0width$}", width = digits as usize))
}

/// RFC 6238 TOTP: the code valid at `now_secs` (Unix time) for a base32
/// `secret`, with the `period` in seconds.
pub fn totp(
    secret_base32: &str,
    algorithm: Algorithm,
    digits: u32,
    period: u32,
    now_secs: u64,
) -> Result<String, CryptoError> {
    if period == 0 {
        return Err(CryptoError::Encryption(
            "TOTP period must be positive".into(),
        ));
    }
    let key = base32_decode(secret_base32)?;
    hotp(&key, algorithm, now_secs / u64::from(period), digits)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 6238 Appendix B: the same ASCII seed repeated to each HMAC's key
    /// length, eight digits, thirty-second period.
    fn seed_for(algorithm: Algorithm) -> Vec<u8> {
        let len = match algorithm {
            Algorithm::Sha1 => 20,
            Algorithm::Sha256 => 32,
            Algorithm::Sha512 => 64,
        };
        b"12345678901234567890"
            .iter()
            .cycle()
            .take(len)
            .copied()
            .collect()
    }

    #[test]
    fn rfc_6238_vectors() {
        let cases: &[(u64, Algorithm, &str)] = &[
            (59, Algorithm::Sha1, "94287082"),
            (59, Algorithm::Sha256, "46119246"),
            (59, Algorithm::Sha512, "90693936"),
            (1_111_111_109, Algorithm::Sha1, "07081804"),
            (1_111_111_109, Algorithm::Sha256, "68084774"),
            (1_111_111_109, Algorithm::Sha512, "25091201"),
            (1_234_567_890, Algorithm::Sha1, "89005924"),
            (2_000_000_000, Algorithm::Sha256, "90698825"),
            (20_000_000_000, Algorithm::Sha512, "47863826"),
        ];
        for (time, algorithm, expected) in cases {
            let code = hotp(&seed_for(*algorithm), *algorithm, time / 30, 8).unwrap();
            assert_eq!(&code, expected, "t={time} {algorithm:?}");
        }
    }

    #[test]
    fn rfc_4226_hotp_vectors_six_digits() {
        let key = b"12345678901234567890";
        let expected = [
            "755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583",
            "399871", "520489",
        ];
        for (counter, want) in expected.iter().enumerate() {
            assert_eq!(
                hotp(key, Algorithm::Sha1, counter as u64, 6).unwrap(),
                *want
            );
        }
    }

    /// RFC 4648 base32 of `bytes`, for building the RFC seed the way an
    /// authenticator app would hand it over. Test-only: the product never
    /// encodes a seed, it only decodes what it is given.
    fn base32_encode(bytes: &[u8]) -> String {
        const ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
        let mut out = String::new();
        let mut buffer: u32 = 0;
        let mut bits = 0;
        for &b in bytes {
            buffer = (buffer << 8) | u32::from(b);
            bits += 8;
            while bits >= 5 {
                bits -= 5;
                out.push(ALPHABET[((buffer >> bits) & 31) as usize] as char);
            }
        }
        if bits > 0 {
            out.push(ALPHABET[((buffer << (5 - bits)) & 31) as usize] as char);
        }
        out
    }

    /// The RFC 6238 SHA-1 seed as base32 text, which is how a QR code carries it.
    fn rfc_seed_base32() -> String {
        base32_encode(b"12345678901234567890")
    }

    #[test]
    fn base32_accepts_what_authenticator_apps_write() {
        let canonical = rfc_seed_base32();
        assert_eq!(canonical.len(), 32);
        let key = base32_decode(&canonical).unwrap();
        assert_eq!(key, b"12345678901234567890");
        // Lower case, grouped with spaces or dashes, padded: all accepted.
        let grouped = canonical
            .to_ascii_lowercase()
            .as_bytes()
            .chunks(4)
            .map(|c| String::from_utf8_lossy(c).to_string())
            .collect::<Vec<_>>()
            .join(" ");
        assert_eq!(base32_decode(&format!("{grouped}====")).unwrap(), key);
        assert_eq!(base32_decode(&grouped.replace(' ', "-")).unwrap(), key);
        assert!(base32_decode("not base32!").is_err());
        assert!(base32_decode("").is_err());
    }

    #[test]
    fn totp_from_a_base32_seed_matches_the_vector() {
        let seed = rfc_seed_base32();
        assert_eq!(totp(&seed, Algorithm::Sha1, 8, 30, 59).unwrap(), "94287082");
        assert_eq!(totp(&seed, Algorithm::Sha1, 6, 30, 59).unwrap(), "287082");
        assert!(totp(&seed, Algorithm::Sha1, 6, 0, 59).is_err());
        assert!(totp(&seed, Algorithm::Sha1, 5, 30, 59).is_err());
    }

    #[test]
    fn algorithm_names_match_otpauth_uris() {
        assert_eq!(Algorithm::parse("SHA1").unwrap(), Algorithm::Sha1);
        assert_eq!(Algorithm::parse("sha256").unwrap(), Algorithm::Sha256);
        assert_eq!(Algorithm::parse("SHA-512").unwrap(), Algorithm::Sha512);
        assert_eq!(Algorithm::parse("").unwrap(), Algorithm::Sha1);
        assert!(Algorithm::parse("MD5").is_err());
    }
}
