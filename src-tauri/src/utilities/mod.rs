// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Vault-wide maintenance and analysis utilities.
//!
//! These operate across every page in the vault (decrypting secret blocks in
//! memory as needed) to produce audit-style reports and bulk transformations:
//! [`breach`] checks passwords against Have I Been Pwned via k-anonymity,
//! [`duplicates`] clusters reused/duplicate credentials, [`health`] scores
//! overall password health, [`consolidate`] merges related pages, [`stats`]
//! summarizes vault composition, [`tags`] manages tags across pages, and
//! [`import_folder`] ingests an existing folder of markdown files. The shared
//! [`collect_all_pages`] helper walks the vault once and returns decrypted-on-
//! demand `(rel_path, meta, content)` triples for the reports to consume.

pub mod breach;
pub mod consolidate;
pub mod duplicates;
pub mod health;
pub mod import_folder;
pub mod rotation;
pub mod stats;
pub mod tags;

use crate::pages::crud::walk_vault_pages;
use crate::pages::error::PageError;
use crate::pages::model::PageMeta;
use std::path::Path;

/// Shared helper: collect all pages as (rel_path, meta, content) triples.
pub(crate) fn collect_all_pages(
    vault_dir: &Path,
) -> Result<Vec<(String, PageMeta, String)>, PageError> {
    let mut pages = Vec::new();
    walk_vault_pages(vault_dir, |rel_path, meta, content| {
        pages.push((rel_path, meta, content));
    })?;
    Ok(pages)
}
