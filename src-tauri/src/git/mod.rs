// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Git integration for the vault, providing auto-commit and version history via the
//! [`git2`](https://docs.rs/git2) crate.
//!
//! Every save is auto-committed with a message of the form
//! `"Update: {page title} — {timestamp}"`, so the vault's `.git/` history doubles as
//! per-page version history that the UI can browse, diff, and restore.
//!
//! - [`ops`] holds the low-level git2 operations: commit, log, per-file log, file-at-commit,
//!   diff, and restore.
//! - [`batch`] holds the debounced [`batch::BatchCommitter`] that coalesces rapid saves into a
//!   single commit over a ~5s window.
//! - [`error`] defines the [`error::GitError`] enum returned across the Tauri IPC boundary.
pub mod batch;
pub mod error;
pub mod ops;
