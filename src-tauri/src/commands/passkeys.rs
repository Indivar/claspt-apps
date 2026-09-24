// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Passkey management for the desktop window.
//!
//! The local API already registers and authenticates passkeys for the browser
//! extension, but only ever for one relying party at a time, because that is
//! all a sign-in needs. Neither of those answers "what passkeys do I have",
//! and nothing could remove one, so a passkey could be created and then never
//! seen or deleted again. These two commands are what the settings screen
//! needs and nothing more.

use tauri::State;
use zeroize::Zeroizing;

use crate::commands::crypto::VaultState;
use crate::pages::error::PageError;
use crate::pages::passkeys::{self, PasskeySummary};

fn get_vault_dir(state: &State<VaultState>) -> Result<std::path::PathBuf, PageError> {
    state.vault_dir().ok_or(PageError::VaultNotOpen)
}

fn get_master_key(state: &State<VaultState>) -> Result<Zeroizing<Vec<u8>>, PageError> {
    state.master_key().ok_or(PageError::VaultNotOpen)
}

/// Every passkey in the vault, newest first, without any private key.
#[tauri::command]
pub fn list_passkeys(state: State<VaultState>) -> Result<Vec<PasskeySummary>, PageError> {
    let vault_dir = get_vault_dir(&state)?;
    let key = get_master_key(&state)?;
    let mut items = passkeys::list_all(&vault_dir, &key)?;
    // Newest first: the one a person is looking for is almost always the one
    // they just made. `created` is RFC 3339, so it sorts as text.
    items.sort_by(|a, b| b.created.cmp(&a.created));
    Ok(items)
}

/// Remove one passkey. The site will keep offering it until the person
/// removes it there too, which the screen says before it asks.
#[tauri::command]
pub fn delete_passkey(
    page_path: String,
    credential_id: String,
    state: State<VaultState>,
) -> Result<(), PageError> {
    let vault_dir = get_vault_dir(&state)?;
    let key = get_master_key(&state)?;
    passkeys::delete(&vault_dir, &key, &page_path, &credential_id)
}
