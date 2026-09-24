// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Constant-time equality for hashes, tokens and verification codes.
//!
//! One function, used by every comparison whose inputs an attacker might
//! control on one side: token hashes in the local API, the `master_key_verify`
//! hash, the keychain adoption check. `ring` used to provide this; its
//! `constant_time` module is deprecated with a note that it makes no promises
//! about side channels, so the comparison comes from the `subtle` crate, which
//! exists for exactly this purpose.

use subtle::ConstantTimeEq;

/// `true` when `a` and `b` are the same bytes, without an early exit on the
/// first differing byte.
///
/// The length check is not constant-time, and does not need to be: the lengths
/// being compared here are public (a hex digest is always 64 bytes, a token
/// hash always the same size).
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && bool::from(a.ct_eq(b))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn equal_bytes_compare_equal() {
        assert!(constant_time_eq(b"abcdef", b"abcdef"));
        assert!(constant_time_eq(b"", b""));
    }

    #[test]
    fn different_bytes_and_different_lengths_compare_unequal() {
        assert!(!constant_time_eq(b"abcdef", b"abcdeg"));
        assert!(!constant_time_eq(b"abcdef", b"abcde"));
        assert!(!constant_time_eq(b"abcdef", b""));
    }
}
