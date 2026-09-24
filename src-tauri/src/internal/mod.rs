// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Internal system pages — hidden bookkeeping data in `.securenotes/internal/`.
//!
//! These pages are:
//! - Hidden from the user's sidebar (already filtered by .securenotes prefix)
//! - Read/written by the app for tracking, audit, preferences
//! - Device-local: the whole of `.securenotes/` is git-ignored and unstaged,
//!   so nothing here is committed or synced
//! - Not indexed in the search engine
//!
//! Each internal page is a JSON file (not markdown) for easy structured
//! read/write. The journals that describe secrets (which credentials are weak
//! or reused, which usernames were filled where, what was shared with whom)
//! are sealed under the master key; see [`store::InternalStore`].

pub mod access_log;
pub mod approval_grants;
pub mod automation;
pub mod device_registry;
pub mod extension_prefs;
pub mod import_history;
pub mod memory_reads;
pub mod security_alerts;
#[cfg(feature = "pro")]
#[rustfmt::skip]
pub mod share_log;
pub mod store;
pub mod templates;
pub mod usage_journal;
pub mod vault_stats;

pub use store::InternalStore;
