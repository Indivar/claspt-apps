// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Import engine for bringing external password/data files into the vault.
//!
//! Parses foreign export formats (CSV, XML, and password-manager exports such
//! as KeePass) into a common preview structure so the user can review entries
//! before they are committed as vault pages with encrypted secret blocks.
//! [`formats`] holds the per-format parsers and [`error`] the shared error type.

pub mod error;
pub mod formats;
