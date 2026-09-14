// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Cryptography facade for the desktop backend.
//!
//! This module is a thin re-export of `claspt_core::crypto` (AES-256-GCM
//! authenticated encryption, Argon2id key derivation, and master-key
//! management). Desktop and mobile both depend on the shared core crate so
//! there is exactly one audited crypto implementation across platforms — the
//! desktop app never defines its own primitives here.
pub use claspt_core::crypto::*;
