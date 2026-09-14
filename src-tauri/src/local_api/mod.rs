// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Localhost HTTP + MCP API surface for the vault.
//!
//! This module exposes a small, loopback-only HTTP server (built on axum) that
//! lets trusted local clients — the browser extension and AI agents/MCP — read
//! and write the vault without going through the Tauri IPC bridge. It binds to
//! `127.0.0.1` only and is never reachable off-device.
//!
//! Access is gated by bearer tokens carrying one of two scopes:
//! - **Notes** (`clsn_` prefix): read/write of non-secret note content. Secret
//!   values are redacted, never decrypted.
//! - **Secrets** (`clss_` prefix, plus legacy `clsp_`): full access including
//!   decryption of secret block values, subject to the secret-approval flow.
//!
//! Submodule map:
//! - [`server`] — server lifecycle, router construction, [`ApiContext`] wiring.
//! - [`auth`] — token scopes and the bearer-token auth middleware.
//! - [`approval`] — the secret-access approval flow ([`ApprovalManager`]).
//! - [`routes`] — the individual HTTP route handlers.
//! - [`api_error`] — the standard JSON error envelope and error→HTTP mapping.
//!
//! [`ApiContext`]: server::ApiContext
pub mod api_error;
pub mod approval;
pub mod auth;
pub mod browser_jobs;
pub mod clients;
pub mod memory_search;
pub mod pairing;
pub mod policy;
pub mod rate_limit;
pub mod routes;
pub mod server;
pub mod services;

pub use approval::ApprovalManager;
pub use browser_jobs::BrowserJobs;
pub use rate_limit::SecretReadLimiter;
pub use server::LocalApiState;
pub use services::{tauri_services, Services};
