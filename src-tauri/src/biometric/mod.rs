// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Biometric unlock backed by the OS keychain.
//!
//! Lets the user unlock the vault with Touch ID (macOS) or Windows Hello
//! instead of retyping the master password. The password (or a derived secret)
//! is held in the platform keychain; a successful biometric check gates its
//! retrieval. Submodules: [`prompt`] triggers the OS biometric dialog and
//! reports availability per platform, [`keystore`] stores/retrieves the secret
//! in the OS keychain, and [`error`] is the shared error type. Linux and other
//! platforms have no standard biometric API and report unavailable.

pub mod error;
pub mod keystore;
pub mod prompt;
