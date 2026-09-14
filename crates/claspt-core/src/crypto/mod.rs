// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Cryptographic primitives for Claspt: the AES-256-GCM AEAD, the Argon2id
//! password KDF, `vault.key` master-key wrapping, and the deterministic sync
//! group key. This module is only a thin tree over those submodules — all key
//! material flows through `zeroize::Zeroizing` wrappers so it is scrubbed from
//! memory on drop, and every symmetric encryption uses a fresh CSPRNG nonce.
pub mod aead;
pub mod error;
pub mod group_key;
pub mod kdf;
pub mod vault_key;
