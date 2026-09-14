// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Auto-commit and version-history queries over the vault's git repository via
//! [`ops`]. Every save stages the whole working tree and records a
//! `"Update: {title} — {timestamp}"` commit; history helpers read per-file logs
//! and diffs for the version viewer. Key invariant: [`ops::commit_changes`] is a
//! no-op when the tree matches HEAD (returns `None` instead of an empty commit),
//! and restores are applied as a new forward commit rather than by rewriting
//! history.
pub mod error;
pub mod ops;
