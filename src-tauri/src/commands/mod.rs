// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Tauri IPC command handlers — the boundary between the React frontend and the
//! Rust backend.
//!
//! Every submodule here exposes `#[tauri::command]` functions that the frontend
//! invokes over Tauri's IPC bridge (via `src/lib/commands.ts`). Each command
//! returns a `Result<T, E>`; the `Err` variant is serialized and surfaces to the
//! frontend as a rejected promise, so error strings/enums here are user- and
//! developer-facing.
//!
//! Submodule map:
//! - [`api`] — local API server control (start/stop, token generation, approvals).
//! - [`biometric`] — OS biometric (Touch ID / Windows Hello) enrollment and unlock.
//! - [`crypto`] — vault create/unlock/lock, config, secret block encrypt/decrypt,
//!   master-key lifecycle and auto-lock watchdogs.
//! - [`export`] — vault and secrets export (zip / CSV / JSON) and zip import.
//! - [`generator`] — password, passphrase, PIN and UUID generation plus strength checks.
//! - [`git`] — version-history queries and manual commit/restore.
//! - [`import`] — CSV / XML / Markdown / JSON import with preview and dedup handling.
//! - `internal`, `license`, `pages`, `search`, `share`, `sync`, `utilities` — other
//!   command groups outside the scope of this documentation pass.

pub mod api;
pub mod biometric;
pub mod crypto;
pub mod export;
pub mod generator;
pub mod git;
pub mod import;
pub mod internal;
#[cfg(feature = "pro")]
pub mod license;
pub mod pages;
pub mod passkeys;
pub mod search;
#[cfg(feature = "pro")]
pub mod share;
#[cfg(feature = "pro")]
pub mod sync;
#[cfg(not(feature = "pro"))]
#[path = "../pro_stubs/sync_commands.rs"]
pub mod sync;
pub mod utilities;
