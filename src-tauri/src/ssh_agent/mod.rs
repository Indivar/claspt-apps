// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! An SSH agent backed by the vault.
//!
//! Private keys stay encrypted in secret blocks on pages tagged `ssh-key`;
//! `ssh` talks to a socket (a named pipe on Windows) the app serves, and each
//! signature request passes the same approval prompt, rate limit and access
//! log as a secret read over the local API. The key is decrypted for the one
//! signature and dropped; `ssh` never sees it, and neither does an agent that
//! runs `ssh` through `claspt run`.

pub mod keys;
pub mod protocol;
pub mod server;

pub use server::{socket_path, SshAgentState};
