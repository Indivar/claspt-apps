// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Tauri IPC commands for page CRUD and media, invoked from the React frontend.
//!
//! This is the primary editing surface: create/read/update/delete pages, list pages,
//! tags, folders and secrets, move/rename/pin/archive, toggle per-page encryption, and
//! save/read media attachments. These handlers own the cross-cutting side effects that
//! the pure `pages` module does not: encrypting secret blocks on save, keeping the search
//! index in sync, and recording saves for the Git batcher. Errors surface to the frontend
//! as `PageError`.
use tauri::State;
use zeroize::Zeroizing;

use super::crypto::VaultState;
use super::git::{record_save_if_active, GitState};
use super::search::{index_page_if_active, remove_page_if_active, SearchState};
use crate::pages::crud;
use crate::pages::error::PageError;
use crate::pages::media::{self, MediaFile};
use crate::pages::model::{Page, PageSummary, SecretSummary};
use crate::pages::secret;
use crate::pages::trash;

fn get_vault_dir(state: &State<VaultState>) -> Result<std::path::PathBuf, PageError> {
    state.vault_dir().ok_or(PageError::VaultNotOpen)
}

fn get_master_key(state: &State<VaultState>) -> Result<Zeroizing<Vec<u8>>, PageError> {
    state.master_key().ok_or(PageError::VaultNotOpen)
}

/// Validate that a source path is within the user's home directory or temp directory.
fn validate_source_path(source_path: &std::path::Path) -> Result<(), PageError> {
    let canonical = source_path.canonicalize().map_err(|e| {
        PageError::InvalidMedia(format!(
            "cannot resolve path {}: {e}",
            source_path.display()
        ))
    })?;
    let allowed = [dirs::home_dir(), Some(std::env::temp_dir())];
    for dir in allowed.iter().flatten() {
        if canonical.starts_with(dir) {
            return Ok(());
        }
    }
    Err(PageError::InvalidMedia(format!(
        "source path {} is outside allowed directories",
        source_path.display()
    )))
}

/// Encrypt page content before writing to disk.
///
/// If `encrypted` is true, the entire body is encrypted as a single blob.
/// Otherwise, only secret blocks within `:::secret[...]:::` fences are encrypted.
fn encrypt_content(
    content: &str,
    encrypted: bool,
    state: &State<VaultState>,
) -> Result<String, PageError> {
    let key = get_master_key(state)?;
    if encrypted {
        secret::encrypt_full_body(content, &key)
    } else {
        secret::encrypt_secrets(content, &key)
    }
}

/// Decrypt page content after reading from disk.
///
/// If `meta.encrypted` is true, the body is decrypted as a single blob.
/// Otherwise, only secret blocks are decrypted.
fn decrypt_page(mut page: Page, state: &State<VaultState>) -> Result<Page, PageError> {
    let key = get_master_key(state)?;
    if page.meta.encrypted {
        page.content = secret::decrypt_full_body(&page.content, &key)?;
    } else {
        page.content = secret::decrypt_secrets(&page.content, &key)?;
    }
    Ok(page)
}

/// Create a new page in `folder` with the given `content`. Secret blocks in the content
/// are encrypted on disk; the plaintext is indexed for search and the save is recorded for
/// the Git batcher. Returns the created page with its plaintext content. Errors as
/// `PageError` (e.g. no vault open, invalid folder, I/O).
#[tauri::command]
pub fn create_page(
    title: String,
    folder: String,
    content: String,
    state: State<VaultState>,
    search_state: State<SearchState>,
    git_state: State<GitState>,
) -> Result<Page, PageError> {
    let vault_dir = get_vault_dir(&state)?;
    let encrypted_content = encrypt_content(&content, false, &state)?;
    let mut page = crud::create_page(&vault_dir, &title, &folder, &encrypted_content, false)?;
    // Index with plaintext content for search
    page.content = content.clone();
    index_page_if_active(&page, &search_state);
    // Record save for batched git commit
    record_save_if_active(&title, &git_state);
    // Return plaintext content to the frontend
    page.content = content;
    Ok(page)
}

/// Read the page at the vault-relative `path` and return it with secret blocks decrypted
/// for display. Errors as `PageError` if the vault is locked or the page is missing.
#[tauri::command]
pub fn read_page(path: String, state: State<VaultState>) -> Result<Page, PageError> {
    let vault_dir = get_vault_dir(&state)?;
    let page = crud::read_page(&vault_dir, &path)?;
    decrypt_page(page, &state)
}

/// Overwrite the content of an existing page, preserving its current encryption mode
/// (per-block vs. full-body). Re-indexes the plaintext and records the save for Git.
/// Returns the updated page with plaintext content.
#[tauri::command]
pub fn update_page(
    path: String,
    content: String,
    state: State<VaultState>,
    search_state: State<SearchState>,
    git_state: State<GitState>,
) -> Result<Page, PageError> {
    let vault_dir = get_vault_dir(&state)?;
    // Read current page to check encryption state
    let current = crud::read_page(&vault_dir, &path)?;
    let encrypted_content = encrypt_content(&content, current.meta.encrypted, &state)?;
    let mut page = crud::update_page(&vault_dir, &path, &encrypted_content)?;
    // Index with plaintext content for search (encrypted pages get empty content)
    page.content = content.clone();
    index_page_if_active(&page, &search_state);
    // Record save for batched git commit
    record_save_if_active(&page.meta.title, &git_state);
    // Return plaintext content to the frontend
    page.content = content;
    Ok(page)
}

/// Delete the page at `path`, removing it from the search index and recording the
/// deletion for the Git batcher.
#[tauri::command]
pub fn delete_page(
    path: String,
    state: State<VaultState>,
    search_state: State<SearchState>,
    git_state: State<GitState>,
) -> Result<trash::TrashEntry, PageError> {
    let vault_dir = get_vault_dir(&state)?;
    // Read the page to get its ID and title before deleting
    let page_info = crud::read_page(&vault_dir, &path).ok();
    if let Some(ref page) = page_info {
        remove_page_if_active(&page.meta.id, &search_state);
    }
    let entry = crud::delete_page(&vault_dir, &path)?;
    // Record deletion for git commit
    if let Some(page) = page_info {
        record_save_if_active(&page.meta.title, &git_state);
    }
    Ok(entry)
}

/// Everything in the vault's trash, newest first.
#[tauri::command]
pub fn trash_list(state: State<VaultState>) -> Result<Vec<trash::TrashEntry>, PageError> {
    let vault_dir = get_vault_dir(&state)?;
    trash::list(&vault_dir, trash::retention_for(&vault_dir))
}

/// Put a trashed page back, index it and record the change for Git.
#[tauri::command]
pub fn trash_restore(
    entry_id: String,
    state: State<VaultState>,
    search_state: State<SearchState>,
    git_state: State<GitState>,
) -> Result<Page, PageError> {
    let vault_dir = get_vault_dir(&state)?;
    let rel_path = trash::restore(&vault_dir, &entry_id)?;
    let page = crud::read_page(&vault_dir, &rel_path)?;
    let decrypted = decrypt_page(page, &state)?;
    index_page_if_active(&decrypted, &search_state);
    record_save_if_active(&format!("Restored: {}", decrypted.meta.title), &git_state);
    Ok(decrypted)
}

/// Remove one trashed page for good. Git still has it.
#[tauri::command]
pub fn trash_purge(entry_id: String, state: State<VaultState>) -> Result<(), PageError> {
    let vault_dir = get_vault_dir(&state)?;
    trash::purge(&vault_dir, &entry_id)
}

/// Remove every trashed page for good. Returns how many went.
#[tauri::command]
pub fn trash_empty(state: State<VaultState>) -> Result<usize, PageError> {
    let vault_dir = get_vault_dir(&state)?;
    trash::empty(&vault_dir, trash::retention_for(&vault_dir))
}

/// Delete many pages in one operation (recorded as a single Git commit). Returns the
/// number of pages actually deleted.
#[tauri::command]
pub fn delete_pages_bulk(
    paths: Vec<String>,
    state: State<VaultState>,
    search_state: State<SearchState>,
    git_state: State<GitState>,
) -> Result<usize, PageError> {
    let vault_dir = get_vault_dir(&state)?;
    // Remove from search index before deleting
    for path in &paths {
        if let Ok(page) = crud::read_page(&vault_dir, path) {
            remove_page_if_active(&page.meta.id, &search_state);
        }
    }
    let count = crud::delete_pages_bulk(&vault_dir, &paths)?;
    // Record as single git commit
    record_save_if_active(&format!("Bulk delete ({count} pages)"), &git_state);
    Ok(count)
}

/// Duplicate the page at `path`, returning the decrypted copy (also indexed and committed).
#[tauri::command]
pub fn duplicate_page(
    path: String,
    state: State<VaultState>,
    search_state: State<SearchState>,
    git_state: State<GitState>,
) -> Result<Page, PageError> {
    let vault_dir = get_vault_dir(&state)?;
    let page = crud::duplicate_page(&vault_dir, &path)?;
    let decrypted = decrypt_page(page, &state)?;
    index_page_if_active(&decrypted, &search_state);
    record_save_if_active(&decrypted.meta.title, &git_state);
    Ok(decrypted)
}

/// Toggle the page's `pinned` flag and return the updated (decrypted) page.
#[tauri::command]
pub fn toggle_pin(
    path: String,
    state: State<VaultState>,
    git_state: State<GitState>,
) -> Result<Page, PageError> {
    let vault_dir = get_vault_dir(&state)?;
    let page = crud::toggle_pin(&vault_dir, &path)?;
    let decrypted = decrypt_page(page, &state)?;
    record_save_if_active(&decrypted.meta.title, &git_state);
    Ok(decrypted)
}

/// Record the owner's review of a memory page an API client wrote. Only pages
/// under `ai/memory/` carry the flag, and only this command (never the API)
/// can set it to true.
#[tauri::command]
pub fn set_memory_reviewed(
    path: String,
    reviewed: bool,
    state: State<VaultState>,
    git_state: State<GitState>,
) -> Result<Page, PageError> {
    let vault_dir = get_vault_dir(&state)?;
    let current = crud::read_page(&vault_dir, &path)?;
    if !crate::pages::agent_memory::is_memory_folder(&current.meta.folder) {
        return Err(PageError::NotFound(format!("{path} is not a memory page")));
    }
    let page = crud::set_reviewed(&vault_dir, &path, reviewed)?;
    let decrypted = decrypt_page(page, &state)?;
    record_save_if_active(&decrypted.meta.title, &git_state);
    Ok(decrypted)
}

/// Toggle the page's `archived` flag and return the updated (decrypted) page.
#[tauri::command]
pub fn toggle_archive(
    path: String,
    state: State<VaultState>,
    git_state: State<GitState>,
) -> Result<Page, PageError> {
    let vault_dir = get_vault_dir(&state)?;
    let page = crud::toggle_archive(&vault_dir, &path)?;
    let decrypted = decrypt_page(page, &state)?;
    record_save_if_active(&decrypted.meta.title, &git_state);
    Ok(decrypted)
}

/// List metadata summaries for every page in the vault. Runs the filesystem scan on a
/// blocking thread so it doesn't stall the async runtime.
#[tauri::command]
pub async fn list_pages(state: State<'_, VaultState>) -> Result<Vec<PageSummary>, PageError> {
    let vault_dir = get_vault_dir(&state)?;
    tokio::task::spawn_blocking(move || crud::list_pages(&vault_dir))
        .await
        .map_err(|e| PageError::Io(std::io::Error::other(e.to_string())))?
}

/// Change a page's title. This also renames the underlying `.md` file, so the returned
/// page carries its new `path`. Re-indexes and records a Git save.
#[tauri::command]
pub fn update_title(
    path: String,
    title: String,
    state: State<VaultState>,
    search_state: State<SearchState>,
    git_state: State<GitState>,
) -> Result<Page, PageError> {
    let vault_dir = get_vault_dir(&state)?;
    let page = crud::update_title(&vault_dir, &path, title)?;
    let decrypted = decrypt_page(page, &state)?;
    index_page_if_active(&decrypted, &search_state);
    record_save_if_active(&decrypted.meta.title, &git_state);
    Ok(decrypted)
}

/// Replace a page's tag list with `tags`. Re-indexes and records a Git save.
#[tauri::command]
pub fn update_tags(
    path: String,
    tags: Vec<String>,
    state: State<VaultState>,
    search_state: State<SearchState>,
    git_state: State<GitState>,
) -> Result<Page, PageError> {
    let vault_dir = get_vault_dir(&state)?;
    let page = crud::update_tags(&vault_dir, &path, tags)?;
    let decrypted = decrypt_page(page, &state)?;
    index_page_if_active(&decrypted, &search_state);
    record_save_if_active(&decrypted.meta.title, &git_state);
    Ok(decrypted)
}

/// Return the de-duplicated, sorted set of all tags used across every page.
#[tauri::command]
pub async fn list_tags(state: State<'_, VaultState>) -> Result<Vec<String>, PageError> {
    let vault_dir = get_vault_dir(&state)?;
    tokio::task::spawn_blocking(move || {
        let pages = crud::list_pages(&vault_dir)?;
        let mut tags = std::collections::BTreeSet::new();
        for page in pages {
            for tag in page.meta.tags {
                tags.insert(tag);
            }
        }
        Ok(tags.into_iter().collect())
    })
    .await
    .map_err(|e| PageError::Io(std::io::Error::other(e.to_string())))?
}

/// List a summary of every secret block across all pages. Only labels and locations are
/// returned — the encrypted values are never decrypted here.
#[tauri::command]
pub async fn list_secrets(state: State<'_, VaultState>) -> Result<Vec<SecretSummary>, PageError> {
    let vault_dir = get_vault_dir(&state)?;
    tokio::task::spawn_blocking(move || crud::list_secrets(&vault_dir))
        .await
        .map_err(|e| PageError::Io(std::io::Error::other(e.to_string())))?
}

/// Move a page into `new_folder` (moves the underlying file) and return the decrypted page.
#[tauri::command]
pub fn move_page(
    path: String,
    new_folder: String,
    state: State<VaultState>,
    search_state: State<SearchState>,
    git_state: State<GitState>,
) -> Result<Page, PageError> {
    let vault_dir = get_vault_dir(&state)?;
    let page = crud::move_page(&vault_dir, &path, &new_folder)?;
    let decrypted = decrypt_page(page, &state)?;
    index_page_if_active(&decrypted, &search_state);
    record_save_if_active(&decrypted.meta.title, &git_state);
    Ok(decrypted)
}

/// List all folder names in the vault.
#[tauri::command]
pub async fn list_folders(state: State<'_, VaultState>) -> Result<Vec<String>, PageError> {
    let vault_dir = get_vault_dir(&state)?;
    tokio::task::spawn_blocking(move || crud::list_folders(&vault_dir))
        .await
        .map_err(|e| PageError::Io(std::io::Error::other(e.to_string())))?
}

/// Create an empty folder and return its normalized name.
#[tauri::command]
pub fn create_folder(
    name: String,
    state: State<VaultState>,
    git_state: State<GitState>,
) -> Result<String, PageError> {
    let vault_dir = get_vault_dir(&state)?;
    let folder_name = crud::create_folder(&vault_dir, &name)?;
    record_save_if_active(&format!("Created folder: {}", folder_name), &git_state);
    Ok(folder_name)
}

/// Rename a folder from `old_name` to `new_name` (moves the pages it contains).
#[tauri::command]
pub fn rename_folder(
    old_name: String,
    new_name: String,
    state: State<VaultState>,
    git_state: State<GitState>,
) -> Result<(), PageError> {
    let vault_dir = get_vault_dir(&state)?;
    crud::rename_folder(&vault_dir, &old_name, &new_name)?;
    record_save_if_active(
        &format!("Renamed folder: {} → {}", old_name, new_name),
        &git_state,
    );
    Ok(())
}

/// Delete a folder. `action` selects the fate of its pages: `"delete_pages"` removes them
/// (and unindexes them, including subfolders), otherwise the pages are moved elsewhere per
/// the action. Runs the filesystem work on a blocking thread.
#[tauri::command]
pub async fn delete_folder(
    name: String,
    action: String,
    state: State<'_, VaultState>,
    search_state: State<'_, SearchState>,
    git_state: State<'_, GitState>,
) -> Result<(), PageError> {
    let vault_dir = get_vault_dir(&state)?;

    // Remove pages from search index (matches folder and all subfolders)
    if action == "delete_pages" {
        if let Ok(pages) = crud::list_pages(&vault_dir) {
            let prefix = format!("{}/", name);
            for page in pages
                .iter()
                .filter(|p| p.meta.folder == name || p.meta.folder.starts_with(&prefix))
            {
                remove_page_if_active(&page.meta.id, &search_state);
            }
        }
    }

    let name_clone = name.clone();
    let vault_dir_clone = vault_dir.clone();
    tokio::task::spawn_blocking(move || {
        crud::delete_folder(&vault_dir_clone, &name_clone, &action)
    })
    .await
    .map_err(|e| PageError::Io(std::io::Error::other(e.to_string())))??;

    record_save_if_active(&format!("Deleted folder: {}", name), &git_state);
    Ok(())
}

/// Switch a page between the two encryption modes: per-`:::secret`-block encryption and
/// full-body encryption (the entire page encrypted). Decrypts with the old mode and
/// re-encrypts with the new one on a blocking thread, updates the `encrypted` meta flag,
/// re-indexes, and commits. Returns the page with plaintext content for the frontend.
#[tauri::command]
pub async fn toggle_encryption(
    path: String,
    state: State<'_, VaultState>,
    search_state: State<'_, SearchState>,
    git_state: State<'_, GitState>,
) -> Result<Page, PageError> {
    let vault_dir = get_vault_dir(&state)?;
    let key = get_master_key(&state)?;

    // Run crypto + file I/O on a blocking thread
    let (page, plaintext) = tokio::task::spawn_blocking(move || {
        // 1. Read raw page from disk
        let raw_page = crud::read_page(&vault_dir, &path)?;
        let was_encrypted = raw_page.meta.encrypted;

        // 2. Decrypt content using current mode
        let plaintext = if was_encrypted {
            secret::decrypt_full_body(&raw_page.content, &key)?
        } else {
            secret::decrypt_secrets(&raw_page.content, &key)?
        };

        // 3. Re-encrypt with the new mode
        let new_encrypted = !was_encrypted;
        let new_content = if new_encrypted {
            secret::encrypt_full_body(&plaintext, &key)?
        } else {
            secret::encrypt_secrets(&plaintext, &key)?
        };

        // 4. Write with updated meta
        let page = crud::update_page_with_meta(&vault_dir, &path, &new_content, |meta| {
            meta.encrypted = new_encrypted;
        })?;

        Ok::<_, PageError>((page, plaintext))
    })
    .await
    .map_err(|e| PageError::Io(std::io::Error::other(e.to_string())))??;

    // 5. Re-index (encrypted pages get empty content in the index)
    let mut index_page = page.clone();
    index_page.content = plaintext.clone();
    index_page_if_active(&index_page, &search_state);

    // 6. Git commit
    record_save_if_active(&page.meta.title, &git_state);

    // 7. Return plaintext page to frontend
    Ok(Page {
        meta: page.meta,
        content: plaintext,
        path: page.path,
    })
}

// ── Media ──────────────────────────────────────────────

/// Name, extension and size of a file the owner picked, so the attach dialog
/// can show the size and apply the vault's limit before anything is read in.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SourceFileInfo {
    pub name: String,
    pub ext: String,
    pub size: u64,
}

/// The vault's options for storing one attachment, with the master key when
/// a sealed file is about to be written.
type AttachmentOptions = (media::SaveOptions, Option<Zeroizing<Vec<u8>>>);

/// The owner's encrypt answer for this file and the vault's size limit, with
/// the master key when a sealed file is about to be written.
fn attachment_options(
    state: &State<VaultState>,
    encrypt: bool,
) -> Result<AttachmentOptions, PageError> {
    let vault_dir = get_vault_dir(state)?;
    let limit_mb = crate::vault::init::read_config(&vault_dir)
        .map(|c| c.attachment_size_limit_mb)
        .unwrap_or(media::DEFAULT_ATTACHMENT_LIMIT_MB);
    let key = state.master_key();
    if encrypt && key.is_none() {
        return Err(PageError::VaultNotOpen);
    }
    Ok((media::SaveOptions::new(encrypt, limit_mb), key))
}

/// Save raw media `data` (with the given `extension`) into the folder's
/// content-addressed `_media/` store, sealed under the master key when
/// `encrypt` is set. Returns the `MediaFile` describing where it landed.
#[tauri::command]
pub async fn save_media(
    folder: String,
    data: Vec<u8>,
    extension: String,
    encrypt: bool,
    state: State<'_, VaultState>,
    git_state: State<'_, GitState>,
) -> Result<MediaFile, PageError> {
    let vault_dir = get_vault_dir(&state)?;
    let (opts, key) = attachment_options(&state, encrypt)?;
    let mf = tokio::task::spawn_blocking(move || {
        media::save_media(
            &vault_dir,
            &folder,
            &data,
            &extension,
            &opts,
            key.as_ref().map(|k| k.as_slice()),
        )
    })
    .await
    .map_err(|e| PageError::Io(std::io::Error::other(e.to_string())))??;
    record_save_if_active(&format!("Added media: {}", mf.md_path), &git_state);
    Ok(mf)
}

/// Import an existing file from `source_path` on disk into the folder's media
/// store. The source path is validated before reading.
#[tauri::command]
pub fn save_media_from_path(
    folder: String,
    source_path: String,
    encrypt: bool,
    state: State<VaultState>,
    git_state: State<GitState>,
) -> Result<MediaFile, PageError> {
    validate_source_path(std::path::Path::new(&source_path))?;
    let vault_dir = get_vault_dir(&state)?;
    let (opts, key) = attachment_options(&state, encrypt)?;
    let mf = media::save_media_from_path(
        &vault_dir,
        &folder,
        std::path::Path::new(&source_path),
        &opts,
        key.as_ref().map(|k| k.as_slice()),
    )?;
    record_save_if_active(&format!("Added media: {}", mf.md_path), &git_state);
    Ok(mf)
}

/// Name, extension and size of a file the owner picked, before it is read.
#[tauri::command]
pub fn stat_source_file(source_path: String) -> Result<SourceFileInfo, PageError> {
    let path = std::path::Path::new(&source_path);
    validate_source_path(path)?;
    let size = std::fs::metadata(path)?.len();
    Ok(SourceFileInfo {
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
        ext: path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase(),
        size,
    })
}

/// Delete a media file by its vault-relative path and record the change for
/// Git. This removes the file from the current version of the vault only;
/// every earlier version keeps it, and the attach dialog says so.
#[tauri::command]
pub fn delete_media(
    rel_path: String,
    state: State<VaultState>,
    git_state: State<GitState>,
) -> Result<(), PageError> {
    let vault_dir = get_vault_dir(&state)?;
    media::delete_media(&vault_dir, &rel_path)?;
    record_save_if_active(&format!("Deleted media: {}", rel_path), &git_state);
    Ok(())
}

/// Seal or unseal an attachment in place. The name and every reference stay.
#[tauri::command]
pub async fn set_media_sealed(
    rel_path: String,
    encrypt: bool,
    state: State<'_, VaultState>,
    git_state: State<'_, GitState>,
) -> Result<MediaFile, PageError> {
    let vault_dir = get_vault_dir(&state)?;
    let key = get_master_key(&state)?;
    let path_for_log = rel_path.clone();
    let mf = tokio::task::spawn_blocking(move || {
        media::set_media_sealed(&vault_dir, &rel_path, encrypt, &key)
    })
    .await
    .map_err(|e| PageError::Io(std::io::Error::other(e.to_string())))??;
    let what = if encrypt { "Encrypted" } else { "Decrypted" };
    record_save_if_active(&format!("{what} media: {path_for_log}"), &git_state);
    Ok(mf)
}

/// The pages of `folder` that reference an attachment, so that deleting it
/// can say what else will lose it.
#[tauri::command]
pub async fn media_references(
    folder: String,
    md_path: String,
    state: State<'_, VaultState>,
) -> Result<media::MediaReferences, PageError> {
    let vault_dir = get_vault_dir(&state)?;
    tokio::task::spawn_blocking(move || media::references(&vault_dir, &folder, &md_path))
        .await
        .map_err(|e| PageError::Io(std::io::Error::other(e.to_string())))?
}

/// Every attachment in the vault, counted and summed by size on disk.
#[tauri::command]
pub async fn media_usage(state: State<'_, VaultState>) -> Result<media::MediaUsage, PageError> {
    let vault_dir = get_vault_dir(&state)?;
    tokio::task::spawn_blocking(move || media::usage(&vault_dir))
        .await
        .map_err(|e| PageError::Io(std::io::Error::other(e.to_string())))?
}

/// Write the original bytes of an attachment to `dest_path`, owner-only,
/// refusing a destination inside the vault (git would commit the copy).
#[tauri::command]
pub async fn export_media(
    rel_path: String,
    dest_path: String,
    state: State<'_, VaultState>,
) -> Result<(), PageError> {
    use std::io::Write;
    let vault_dir = get_vault_dir(&state)?;
    super::export::reject_destination_inside_vault(&vault_dir, &dest_path)?;
    let key = state.master_key();
    tokio::task::spawn_blocking(move || {
        let bytes =
            media::read_media_bytes(&vault_dir, &rel_path, key.as_ref().map(|k| k.as_slice()))?;
        let mut file = claspt_core::fs_perms::create_owner_only(std::path::Path::new(&dest_path))?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        Ok::<(), PageError>(())
    })
    .await
    .map_err(|e| PageError::Io(std::io::Error::other(e.to_string())))?
}

/// Resolve a page-relative `_media/...` reference to an absolute path on disk.
#[tauri::command]
pub fn resolve_media_path(
    folder: String,
    md_path: String,
    state: State<VaultState>,
) -> Result<String, PageError> {
    let vault_dir = get_vault_dir(&state)?;
    let abs = media::resolve_media_path(&vault_dir, &folder, &md_path)?;
    Ok(abs.to_string_lossy().to_string())
}

/// Read a media file and return it as a base64 `data:` URL (MIME inferred
/// from extension) so the frontend can render it inline without filesystem
/// access. A sealed file is opened with the master key and reported as such.
#[tauri::command]
pub async fn read_media_data_url(
    folder: String,
    md_path: String,
    include_data: bool,
    state: State<'_, VaultState>,
) -> Result<media::MediaRead, PageError> {
    let vault_dir = get_vault_dir(&state)?;
    let key = state.master_key();
    tokio::task::spawn_blocking(move || {
        media::read_media(
            &vault_dir,
            &folder,
            &md_path,
            key.as_ref().map(|k| k.as_slice()),
            include_data,
        )
    })
    .await
    .map_err(|e| PageError::Io(std::io::Error::other(e.to_string())))?
}

// ── Image Transform ──────────────────────────────────────

/// Preview the result of an image transform (crop/resize/etc.) without persisting it, so
/// the UI can show a live preview. The source path is validated first.
#[tauri::command]
pub async fn preview_image_transform(
    source_path: String,
    params: media::ImageTransformParams,
) -> Result<media::ImageTransformPreview, PageError> {
    validate_source_path(std::path::Path::new(&source_path))?;
    tokio::task::spawn_blocking(move || {
        media::preview_image_transform(std::path::Path::new(&source_path), &params)
    })
    .await
    .map_err(|e| PageError::Io(std::io::Error::other(e.to_string())))?
}

/// The same preview for bytes the editor already holds (a paste or a drop).
#[tauri::command]
pub async fn preview_image_transform_bytes(
    data: Vec<u8>,
    extension: String,
    params: media::ImageTransformParams,
) -> Result<media::ImageTransformPreview, PageError> {
    tokio::task::spawn_blocking(move || {
        media::preview_image_transform_bytes(&data, &extension, &params)
    })
    .await
    .map_err(|e| PageError::Io(std::io::Error::other(e.to_string())))?
}

/// Apply an image transform to the source image and save the result into the folder's
/// media store, returning the resulting `MediaFile`.
#[tauri::command]
pub async fn process_and_save_media(
    folder: String,
    source_path: String,
    params: media::ImageTransformParams,
    encrypt: bool,
    state: State<'_, VaultState>,
    git_state: State<'_, GitState>,
) -> Result<MediaFile, PageError> {
    validate_source_path(std::path::Path::new(&source_path))?;
    let vault_dir = get_vault_dir(&state)?;
    let (opts, key) = attachment_options(&state, encrypt)?;
    let mf = tokio::task::spawn_blocking(move || {
        media::process_and_save_media(
            &vault_dir,
            &folder,
            std::path::Path::new(&source_path),
            &params,
            &opts,
            key.as_ref().map(|k| k.as_slice()),
        )
    })
    .await
    .map_err(|e| PageError::Io(std::io::Error::other(e.to_string())))??;
    record_save_if_active(&format!("Added media: {}", mf.md_path), &git_state);
    Ok(mf)
}

/// Transform bytes the editor already holds and save the result.
#[tauri::command]
pub async fn process_and_save_media_bytes(
    folder: String,
    data: Vec<u8>,
    extension: String,
    params: media::ImageTransformParams,
    encrypt: bool,
    state: State<'_, VaultState>,
    git_state: State<'_, GitState>,
) -> Result<MediaFile, PageError> {
    let vault_dir = get_vault_dir(&state)?;
    let (opts, key) = attachment_options(&state, encrypt)?;
    let mf = tokio::task::spawn_blocking(move || {
        media::process_and_save_media_bytes(
            &vault_dir,
            &folder,
            &data,
            &extension,
            &params,
            &opts,
            key.as_ref().map(|k| k.as_slice()),
        )
    })
    .await
    .map_err(|e| PageError::Io(std::io::Error::other(e.to_string())))??;
    record_save_if_active(&format!("Added media: {}", mf.md_path), &git_state);
    Ok(mf)
}
