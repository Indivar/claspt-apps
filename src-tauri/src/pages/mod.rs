// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Page management: CRUD for the `.md` note files that make up a vault.
//!
//! Every note is a portable Markdown file with a YAML frontmatter header. This
//! module owns everything that reads or writes those files, split into focused
//! submodules:
//!
//! - [`model`] — the [`model::Page`] / [`model::PageMeta`] types plus frontmatter
//!   parse/serialize and filename/snippet helpers.
//! - [`crud`] — create/read/update/delete of pages and folders, with path-traversal
//!   guards and atomic writes.
//! - [`secret`] — the `:::secret[Label]…:::` fence format: encrypt-on-save,
//!   decrypt-on-read, and block-level (field) operations.
//! - [`media`] — image/attachment storage under each folder's `_media/` directory.
//! - [`agent_memory`] / [`agent_secret`] — agent-facing (MCP) memory notes and
//!   credential storage, layered on top of the CRUD and secret primitives.
//! - [`error`] — the shared [`error::PageError`] type surfaced to the frontend.
//!
//! Tauri command handlers (defined elsewhere in the backend) call into these
//! functions; the functions themselves are transport-agnostic and operate on a
//! vault directory path.
pub mod agent_memory;
pub mod agent_secret;
pub mod credential_shape;
pub mod crud;
pub mod error;
pub mod media;
pub mod model;
pub mod passkeys;
pub mod secret;
pub mod secret_guard;
