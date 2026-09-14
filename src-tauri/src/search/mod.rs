// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Full-text search over vault pages, backed by a [tantivy](https://docs.rs/tantivy)
//! index stored locally under `.securenotes/index/`.
//!
//! The index covers page titles, tags, secret block labels, and plaintext content, with
//! per-field score boosts (title 3x, tags 2x, secret labels 2x, content 1x). Secret block
//! *values* are never indexed — only their labels — so decrypted secrets never touch the
//! index on disk.
//!
//! - [`engine`] defines the tantivy schema, index open/build, incremental indexing, and
//!   query execution with field boosts and search-as-you-type prefix expansion.
//! - [`error`] defines the [`error::SearchError`] enum returned across the Tauri IPC boundary.
pub mod engine;
pub mod error;
