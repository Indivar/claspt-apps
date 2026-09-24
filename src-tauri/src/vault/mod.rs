// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Vault module — the on-disk Claspt vault and its lifecycle.
//!
//! A vault is a directory (default `~/Claspt`) holding plaintext note folders plus a
//! `.securenotes/` metadata directory with `config.json`, the encrypted `vault.key`, the
//! local tantivy search index, the license token, and sync/brute-force state. Secret block
//! *values* are AES-256-GCM encrypted; labels, page titles, folder names, and other content
//! stay plaintext for markdown portability. `vault.key` is never synced — each device derives
//! its own from the master password.
//!
//! Submodule map:
//! - [`auth`] — master-password validation, key derivation, and brute-force throttling on unlock.
//! - [`config`] — the `config.json` schema ([`config::VaultConfig`]), its defaults, and validation.
//! - [`error`] — the [`error::VaultError`] enum shared across vault operations.
//! - [`init`] — vault directory scaffolding, config read/write, and help-page seeding/refresh.
//! - [`help_pages`] — built-in welcome/help page content seeded into a new vault.
pub mod auth;
pub mod config;
pub mod error;
pub mod help_pages;
pub mod init;
pub mod last_opened;
pub mod recovery_sheet;
pub mod token_store;

#[cfg(test)]
mod old_vault_tests;
