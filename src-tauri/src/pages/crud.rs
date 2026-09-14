// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Page and folder CRUD against the vault directory.
//!
//! Implements create/read/update/delete for pages and folders, plus listing,
//! moving, pinning, archiving, tag/title edits, and vault-wide traversal. Two
//! cross-cutting safety concerns live here:
//!
//! - **Path safety.** Every relative path from the frontend is resolved through
//!   [`safe_join`], which rejects `..` traversal and canonicalizes to confirm the
//!   result stays inside the vault before any file is touched.
//! - **Crash safety.** Writes go through [`atomic_write`] (write to a `.tmp` file,
//!   then rename) so an interrupted write can never leave a half-written note.
//!
//! Folder operations treat `general` as the undeletable/unrenamable default and
//! skip hidden directories (`.git`, `.securenotes`, and the legacy `.agent`
//! memory location) and per-folder `_media` directories when walking the tree.
//! Agent memory now lives in the visible `ai/memory/` tree and is walked like
//! any other folder.

use std::path::{Path, PathBuf};

use chrono::Utc;
use uuid::Uuid;
use walkdir::WalkDir;

use super::error::PageError;
use super::model::{self, Page, PageMeta, PageSummary, SecretSummary};
use super::secret;

/// Atomically write data to a file using temp-file + rename.
/// Prevents data corruption if the process crashes mid-write.
fn atomic_write(path: &Path, data: &[u8]) -> Result<(), PageError> {
    let tmp_path = path.with_extension("tmp");
    if let Err(e) = std::fs::write(&tmp_path, data) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(e.into());
    }
    if let Err(e) = std::fs::rename(&tmp_path, path) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(e.into());
    }
    Ok(())
}

/// Join a relative path to a base directory, rejecting traversal attempts.
pub(crate) fn safe_join(base: &Path, rel: &str) -> Result<PathBuf, PageError> {
    // Fast rejection: no `..` components allowed
    if rel.split(['/', '\\']).any(|c| c == "..") {
        return Err(PageError::NotFound(rel.to_string()));
    }
    let joined = base.join(rel);
    let canonical_base = base.canonicalize().map_err(PageError::from)?;
    let canonical = if joined.exists() {
        joined.canonicalize().map_err(PageError::from)?
    } else {
        // For new paths, canonicalize the existing parent
        let parent = joined
            .parent()
            .ok_or_else(|| PageError::NotFound(rel.to_string()))?;
        let canon_parent = if parent.exists() {
            parent.canonicalize().map_err(PageError::from)?
        } else {
            // Walk up ancestors to find the nearest existing directory and canonicalize
            let mut ancestor = parent.to_path_buf();
            let mut suffix_parts = Vec::new();
            loop {
                if ancestor.exists() {
                    let canon = ancestor.canonicalize().map_err(PageError::from)?;
                    // Reconstruct with canonical base + remaining parts
                    let mut result = canon;
                    for part in suffix_parts.into_iter().rev() {
                        result = result.join(part);
                    }
                    break result;
                }
                if let Some(name) = ancestor.file_name() {
                    suffix_parts.push(name.to_os_string());
                    ancestor = ancestor
                        .parent()
                        .ok_or_else(|| PageError::NotFound(rel.to_string()))?
                        .to_path_buf();
                } else {
                    return Err(PageError::NotFound(rel.to_string()));
                }
            }
        };
        canon_parent.join(
            joined
                .file_name()
                .ok_or_else(|| PageError::NotFound(rel.to_string()))?,
        )
    };
    if !canonical.starts_with(&canonical_base) {
        return Err(PageError::NotFound(rel.to_string()));
    }
    Ok(joined)
}

/// Create a new page in the vault.
pub fn create_page(
    vault_dir: &Path,
    title: &str,
    folder: &str,
    content: &str,
    encrypted: bool,
) -> Result<Page, PageError> {
    let now = Utc::now();
    let id = Uuid::new_v4().to_string();
    let base_filename = model::generate_filename(title, &now);

    // Validate here rather than at each call site. `safe_join` only keeps the
    // path inside the vault, which `.securenotes` and `.git` both satisfy, so a
    // caller that skipped its own check could create pages among the vault's
    // internals. The local API route checked; the MCP server's direct-vault mode
    // did not, and it reaches this function with a caller-supplied folder.
    validate_folder_path(folder)?;

    let folder_dir = safe_join(vault_dir, folder)?;
    std::fs::create_dir_all(&folder_dir)?;

    // Disambiguate on collision. Filenames are `date(sec)+slug`, so two pages
    // with the same title created in the same second would otherwise map to the
    // same file and the second would silently overwrite the first (hit hard by
    // CSV/bulk import). Append `-2`, `-3`, … until the name is free.
    let (filename, file_path) = {
        let mut candidate = base_filename.clone();
        let mut n = 2;
        loop {
            let p = folder_dir.join(&candidate);
            if !p.exists() {
                break (candidate, p);
            }
            let stem = base_filename.strip_suffix(".md").unwrap_or(&base_filename);
            candidate = format!("{stem}-{n}.md");
            n += 1;
        }
    };
    let rel_path = format!("{}/{}", folder, filename);

    let meta = PageMeta {
        id,
        title: title.to_string(),
        created_at: now,
        updated_at: now,
        pinned: false,
        archived: false,
        tags: vec![],
        folder: folder.to_string(),
        encrypted,
        agent_ns: None,
        memory_type: None,
        ttl_hours: None,
        custom_meta: None,
        written_by_client: None,
        written_by_name: None,
        memory_kind: None,
        valid_from: None,
        valid_until: None,
        superseded_by: None,
        verified_on: None,
        reviewed: None,
    };

    let raw = model::serialize_page(&meta, content)?;
    atomic_write(&file_path, raw.as_bytes())?;

    Ok(Page {
        meta,
        content: content.to_string(),
        path: rel_path,
    })
}

/// Read a page from disk by relative path.
pub fn read_page(vault_dir: &Path, rel_path: &str) -> Result<Page, PageError> {
    let file_path = safe_join(vault_dir, rel_path)?;
    if !file_path.exists() {
        return Err(PageError::NotFound(rel_path.to_string()));
    }

    let raw = std::fs::read_to_string(&file_path)?;
    let (meta, content) = model::parse_page(&raw)?;

    Ok(Page {
        meta,
        content,
        path: rel_path.to_string(),
    })
}

/// Update a page's content and updated_at timestamp.
pub fn update_page(vault_dir: &Path, rel_path: &str, content: &str) -> Result<Page, PageError> {
    let file_path = safe_join(vault_dir, rel_path)?;
    if !file_path.exists() {
        return Err(PageError::NotFound(rel_path.to_string()));
    }

    let raw = std::fs::read_to_string(&file_path)?;
    let (mut meta, _) = model::parse_page(&raw)?;
    meta.updated_at = Utc::now();

    let new_raw = model::serialize_page(&meta, content)?;
    atomic_write(&file_path, new_raw.as_bytes())?;

    Ok(Page {
        meta,
        content: content.to_string(),
        path: rel_path.to_string(),
    })
}

/// Update a page's content and metadata atomically.
///
/// The `mutate_meta` closure receives a mutable reference to the current
/// PageMeta, allowing callers to change any fields (e.g. toggling `encrypted`).
pub fn update_page_with_meta<F>(
    vault_dir: &Path,
    rel_path: &str,
    content: &str,
    mutate_meta: F,
) -> Result<Page, PageError>
where
    F: FnOnce(&mut PageMeta),
{
    let file_path = safe_join(vault_dir, rel_path)?;
    if !file_path.exists() {
        return Err(PageError::NotFound(rel_path.to_string()));
    }

    let raw = std::fs::read_to_string(&file_path)?;
    let (mut meta, _) = model::parse_page(&raw)?;
    mutate_meta(&mut meta);
    meta.updated_at = Utc::now();

    let new_raw = model::serialize_page(&meta, content)?;
    atomic_write(&file_path, new_raw.as_bytes())?;

    Ok(Page {
        meta,
        content: content.to_string(),
        path: rel_path.to_string(),
    })
}

/// Delete a page by moving it to the system trash.
pub fn delete_page(vault_dir: &Path, rel_path: &str) -> Result<(), PageError> {
    let file_path = safe_join(vault_dir, rel_path)?;
    if !file_path.exists() {
        return Err(PageError::NotFound(rel_path.to_string()));
    }

    trash::delete(&file_path).map_err(|e| PageError::Trash(e.to_string()))?;
    Ok(())
}

/// Delete multiple pages permanently (not trash) for fast bulk operations.
/// Uses direct filesystem removal to avoid macOS Finder's slow trash API.
/// The vault is git-tracked, so files can be recovered from git history.
pub fn delete_pages_bulk(vault_dir: &Path, rel_paths: &[String]) -> Result<usize, PageError> {
    let mut count = 0;
    for rel_path in rel_paths {
        if let Ok(fp) = safe_join(vault_dir, rel_path) {
            if fp.exists() {
                std::fs::remove_file(&fp)?;
                count += 1;
            }
        }
    }
    Ok(count)
}

/// Duplicate a page with a new UUID, timestamps, and " (Copy)" title suffix.
pub fn duplicate_page(vault_dir: &Path, rel_path: &str) -> Result<Page, PageError> {
    let original = read_page(vault_dir, rel_path)?;
    let new_title = format!("{} (Copy)", original.meta.title);
    create_page(
        vault_dir,
        &new_title,
        &original.meta.folder,
        &original.content,
        original.meta.encrypted,
    )
}

/// Read a page, apply a metadata mutation (preserving content), bump updated_at, and write back.
fn modify_page_meta<F>(vault_dir: &Path, rel_path: &str, mutate: F) -> Result<Page, PageError>
where
    F: FnOnce(&mut PageMeta),
{
    let file_path = safe_join(vault_dir, rel_path)?;
    if !file_path.exists() {
        return Err(PageError::NotFound(rel_path.to_string()));
    }

    let raw = std::fs::read_to_string(&file_path)?;
    let (mut meta, content) = model::parse_page(&raw)?;
    mutate(&mut meta);
    meta.updated_at = Utc::now();

    let new_raw = model::serialize_page(&meta, &content)?;
    atomic_write(&file_path, new_raw.as_bytes())?;

    Ok(Page {
        meta,
        content,
        path: rel_path.to_string(),
    })
}

/// Toggle pinned state for a page.
pub fn toggle_pin(vault_dir: &Path, rel_path: &str) -> Result<Page, PageError> {
    modify_page_meta(vault_dir, rel_path, |meta| meta.pinned = !meta.pinned)
}

/// Set the pinned state of a page to an explicit value (idempotent).
pub fn set_pinned(vault_dir: &Path, rel_path: &str, value: bool) -> Result<Page, PageError> {
    modify_page_meta(vault_dir, rel_path, |meta| meta.pinned = value)
}

/// Toggle the archived state of a page.
pub fn toggle_archive(vault_dir: &Path, rel_path: &str) -> Result<Page, PageError> {
    modify_page_meta(vault_dir, rel_path, |meta| meta.archived = !meta.archived)
}

/// Set the archived state of a page to an explicit value (idempotent).
pub fn set_archived(vault_dir: &Path, rel_path: &str, value: bool) -> Result<Page, PageError> {
    modify_page_meta(vault_dir, rel_path, |meta| meta.archived = value)
}

/// Record whether the vault owner has reviewed a page an API client wrote.
/// Only the app calls this; the API has no route to it, so a client cannot
/// mark its own writes reviewed.
pub fn set_reviewed(vault_dir: &Path, rel_path: &str, value: bool) -> Result<Page, PageError> {
    modify_page_meta(vault_dir, rel_path, |meta| meta.reviewed = Some(value))
}

/// Update a page's title.
pub fn update_title(vault_dir: &Path, rel_path: &str, title: String) -> Result<Page, PageError> {
    modify_page_meta(vault_dir, rel_path, |meta| meta.title = title)
}

/// Update a page's tags.
pub fn update_tags(vault_dir: &Path, rel_path: &str, tags: Vec<String>) -> Result<Page, PageError> {
    modify_page_meta(vault_dir, rel_path, |meta| meta.tags = tags)
}

/// Iterate all `.md` files in the vault, skipping hidden directories and `_media`.
/// Calls `visitor` with `(relative_path, meta, content)` for each successfully parsed page.
pub(crate) fn walk_vault_pages<F>(vault_dir: &Path, mut visitor: F) -> Result<(), PageError>
where
    F: FnMut(String, PageMeta, String),
{
    for entry in WalkDir::new(vault_dir)
        .into_iter()
        .filter_entry(|e| {
            if e.depth() == 0 {
                return true;
            }
            let name = e.file_name().to_string_lossy();
            !name.starts_with('.') && name != "_media"
        })
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if path.is_file() && path.extension().is_some_and(|ext| ext == "md") {
            let rel_path = path
                .strip_prefix(vault_dir)
                .unwrap_or(path)
                .to_string_lossy()
                .to_string();

            if let Ok(raw) = std::fs::read_to_string(path) {
                if let Ok((meta, content)) = model::parse_page(&raw) {
                    visitor(rel_path, meta, content);
                }
            }
        }
    }
    Ok(())
}

/// List all pages in the vault (recursive), sorted by pinned then updated_at desc.
pub fn list_pages(vault_dir: &Path) -> Result<Vec<PageSummary>, PageError> {
    let mut pages = Vec::new();

    walk_vault_pages(vault_dir, |rel_path, meta, content| {
        let snippet = if meta.encrypted {
            "[Encrypted page]".to_string()
        } else {
            model::make_snippet(&content, 200)
        };
        pages.push(PageSummary {
            meta,
            path: rel_path,
            snippet,
        });
    })?;

    // Sort: pinned first, then by updated_at descending
    pages.sort_by(|a, b| {
        b.meta
            .pinned
            .cmp(&a.meta.pinned)
            .then(b.meta.updated_at.cmp(&a.meta.updated_at))
    });

    Ok(pages)
}

/// List all secret block labels across all pages in the vault.
pub fn list_secrets(vault_dir: &Path) -> Result<Vec<SecretSummary>, PageError> {
    let mut secrets = Vec::new();

    walk_vault_pages(vault_dir, |rel_path, meta, content| {
        for label in secret::extract_secret_labels(&content) {
            secrets.push(SecretSummary {
                label,
                page_title: meta.title.clone(),
                page_path: rel_path.clone(),
                folder: meta.folder.clone(),
                created_at: meta.created_at,
            });
        }
    })?;

    // Sort by label alphabetically
    secrets.sort_by(|a, b| a.label.to_lowercase().cmp(&b.label.to_lowercase()));
    Ok(secrets)
}

/// Move a page to a different folder.
pub fn move_page(vault_dir: &Path, rel_path: &str, new_folder: &str) -> Result<Page, PageError> {
    // The destination gets the same treatment as `create_folder` and
    // `rename_folder`: no dot-segments, so a page cannot be relocated into
    // `.securenotes` or `.git`.
    validate_folder_path(new_folder)?;

    let file_path = safe_join(vault_dir, rel_path)?;
    if !file_path.exists() {
        return Err(PageError::NotFound(rel_path.to_string()));
    }

    let raw = std::fs::read_to_string(&file_path)?;
    let (mut meta, content) = model::parse_page(&raw)?;
    let old_folder = meta.folder.clone();

    let filename = file_path
        .file_name()
        .ok_or_else(|| PageError::NotFound(rel_path.to_string()))?;

    let new_folder_dir = safe_join(vault_dir, new_folder)?;
    std::fs::create_dir_all(&new_folder_dir)?;

    let new_file_path = new_folder_dir.join(filename);
    let new_rel_path = format!("{}/{}", new_folder, filename.to_string_lossy());

    meta.folder = new_folder.to_string();
    meta.updated_at = Utc::now();

    let new_raw = model::serialize_page(&meta, &content)?;
    atomic_write(&new_file_path, new_raw.as_bytes())?;
    std::fs::remove_file(&file_path)?;

    // Move referenced media files to the new folder
    if old_folder != new_folder {
        let _ = super::media::move_media_for_page(vault_dir, &content, &old_folder, new_folder);
    }

    Ok(Page {
        meta,
        content,
        path: new_rel_path,
    })
}

/// Validate a folder path (possibly nested, e.g. `"work/aws/production"`).
fn validate_folder_path(path: &str) -> Result<(), PageError> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(PageError::InvalidFolderName("path cannot be empty".into()));
    }
    if trimmed.contains('\\')
        || trimmed.starts_with('/')
        || trimmed.ends_with('/')
        || trimmed.contains("//")
    {
        return Err(PageError::InvalidFolderName(format!(
            "invalid folder path: {trimmed}"
        )));
    }
    for segment in trimmed.split('/') {
        let seg = segment.trim();
        if seg.is_empty() || seg == "." || seg == ".." || seg.starts_with('.') {
            return Err(PageError::InvalidFolderName(format!(
                "invalid segment in path: {seg}"
            )));
        }
    }
    Ok(())
}

/// List all folders in the vault recursively, excluding hidden directories and `_media`.
/// Returns paths relative to the vault root, e.g. `["credentials", "credentials/work", "general"]`.
pub fn list_folders(vault_dir: &Path) -> Result<Vec<String>, PageError> {
    let mut folders = Vec::new();
    collect_folders_recursive(vault_dir, vault_dir, &mut folders)?;
    folders.sort_by_key(|a| a.to_lowercase());
    Ok(folders)
}

fn collect_folders_recursive(
    vault_dir: &Path,
    current: &Path,
    folders: &mut Vec<String>,
) -> Result<(), PageError> {
    for entry in std::fs::read_dir(current)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.starts_with('.') && name != "_media" {
                let rel = path
                    .strip_prefix(vault_dir)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .to_string();
                folders.push(rel);
                collect_folders_recursive(vault_dir, &path, folders)?;
            }
        }
    }
    Ok(())
}

/// Create a folder in the vault, supporting nested paths like `"work/aws"`.
pub fn create_folder(vault_dir: &Path, name: &str) -> Result<String, PageError> {
    let name_trimmed = name.trim().to_string();
    validate_folder_path(&name_trimmed)?;

    let folder_path = safe_join(vault_dir, &name_trimmed)?;
    if folder_path.exists() {
        return Err(PageError::FolderExists(name_trimmed));
    }
    std::fs::create_dir_all(&folder_path)?;
    Ok(name_trimmed)
}

/// Rename a folder (possibly nested). Updates the directory and all page metadata inside,
/// cascading the path change to all descendant pages.
pub fn rename_folder(vault_dir: &Path, old_name: &str, new_name: &str) -> Result<(), PageError> {
    let old_trimmed = old_name.trim();
    let new_trimmed = new_name.trim();

    if old_trimmed == "general" || old_trimmed.starts_with("general/") {
        return Err(PageError::DefaultFolder);
    }
    validate_folder_path(old_trimmed)?;
    validate_folder_path(new_trimmed)?;

    let old_path = safe_join(vault_dir, old_trimmed)?;
    if !old_path.is_dir() {
        return Err(PageError::FolderNotFound(old_trimmed.to_string()));
    }
    let new_path = safe_join(vault_dir, new_trimmed)?;
    if new_path.exists() {
        return Err(PageError::FolderExists(new_trimmed.to_string()));
    }

    // Ensure parent of new path exists (e.g. renaming "a/b" to "x/y/b")
    if let Some(parent) = new_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    std::fs::rename(&old_path, &new_path)?;

    // Update frontmatter: derive correct folder from filesystem path for each page
    for entry in WalkDir::new(&new_path).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.is_file() && path.extension().is_some_and(|ext| ext == "md") {
            if let Ok(raw) = std::fs::read_to_string(path) {
                if let Ok((mut meta, content)) = model::parse_page(&raw) {
                    if let Ok(rel) = path.parent().unwrap_or(path).strip_prefix(vault_dir) {
                        meta.folder = rel.to_string_lossy().to_string();
                        if let Ok(new_raw) = model::serialize_page(&meta, &content) {
                            let _ = atomic_write(path, new_raw.as_bytes());
                        }
                    }
                }
            }
        }
    }

    Ok(())
}

/// Delete a folder (possibly nested) with an action for its pages.
///
/// `action` is one of:
/// - `"delete_pages"` — delete all pages in the folder and sub-folders, then remove the directory.
/// - `"move_pages:<target_folder>"` — move all pages to the target folder, then remove the directory.
pub fn delete_folder(vault_dir: &Path, name: &str, action: &str) -> Result<(), PageError> {
    let name_trimmed = name.trim();
    if name_trimmed == "general" {
        return Err(PageError::DefaultFolder);
    }
    // Reject dot-segments before anything else. `safe_join` only keeps the path
    // inside the vault, which `.securenotes` and `.git` both satisfy — and the
    // `remove_dir_all` at the end of this function would then take the encrypted
    // master key, or the entire version history, with it.
    validate_folder_path(name_trimmed)?;

    let folder_path = safe_join(vault_dir, name_trimmed)?;
    if !folder_path.is_dir() {
        return Err(PageError::FolderNotFound(name_trimmed.to_string()));
    }

    // Collect page relative paths inside this folder (and all sub-folders)
    let mut page_paths = Vec::new();
    for entry in WalkDir::new(&folder_path)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if path.is_file() && path.extension().is_some_and(|ext| ext == "md") {
            if let Ok(rel) = path.strip_prefix(vault_dir) {
                page_paths.push(rel.to_string_lossy().to_string());
            }
        }
    }

    if action == "delete_pages" {
        // Bulk delete: remove files directly instead of sending each to Trash.
        // The folder tree is removed by remove_dir_all below, so Trash is unnecessary
        // and would be extremely slow for hundreds of files (each triggers macOS Finder).
        for rel_path in &page_paths {
            let file_path = safe_join(vault_dir, rel_path)?;
            if file_path.exists() {
                std::fs::remove_file(&file_path)?;
            }
        }
    } else if let Some(target) = action.strip_prefix("move_pages:") {
        validate_folder_path(target)?;
        for rel_path in &page_paths {
            move_page(vault_dir, rel_path, target)?;
        }
    } else {
        return Err(PageError::InvalidFolderName(format!(
            "unknown action: {}",
            action
        )));
    }

    // Remove the now-empty directory tree
    if folder_path.exists() {
        std::fs::remove_dir_all(&folder_path)?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use tempfile::tempdir;

    fn setup_vault() -> (tempfile::TempDir, PathBuf) {
        let dir = tempdir().unwrap();
        let vault = dir.path().to_path_buf();
        std::fs::create_dir_all(vault.join("general")).unwrap();
        (dir, vault)
    }

    #[test]
    fn create_and_read_page() {
        let (_dir, vault) = setup_vault();
        let page = create_page(&vault, "My Note", "general", "# Hello\nWorld", false).unwrap();

        assert_eq!(page.meta.title, "My Note");
        assert_eq!(page.meta.folder, "general");
        assert!(!page.meta.id.is_empty());
        assert!(page.path.ends_with(".md"));

        let read = read_page(&vault, &page.path).unwrap();
        assert_eq!(read.meta.id, page.meta.id);
        assert_eq!(read.content, "# Hello\nWorld");
    }

    #[test]
    fn set_pinned_archived_is_idempotent() {
        let (_dir, vault) = setup_vault();
        let page = create_page(&vault, "Note", "general", "x", false).unwrap();
        assert!(!page.meta.pinned);

        // Explicit set is idempotent (unlike toggle): setting true twice stays true.
        let p = set_pinned(&vault, &page.path, true).unwrap();
        assert!(p.meta.pinned);
        let p = set_pinned(&vault, &p.path, true).unwrap();
        assert!(p.meta.pinned, "set(true) must be idempotent, not toggle");
        let p = set_pinned(&vault, &p.path, false).unwrap();
        assert!(!p.meta.pinned);

        let a = set_archived(&vault, &page.path, true).unwrap();
        assert!(a.meta.archived);
        let a = set_archived(&vault, &a.path, true).unwrap();
        assert!(a.meta.archived, "set(true) must be idempotent, not toggle");
    }

    #[test]
    fn update_page_changes_timestamp() {
        let (_dir, vault) = setup_vault();
        let page = create_page(&vault, "Note", "general", "Old content", false).unwrap();
        let original_updated = page.meta.updated_at;

        std::thread::sleep(std::time::Duration::from_millis(10));

        let updated = update_page(&vault, &page.path, "New content").unwrap();
        assert!(updated.meta.updated_at > original_updated);
        assert_eq!(updated.content, "New content");
    }

    #[test]
    fn duplicate_page_creates_copy() {
        let (_dir, vault) = setup_vault();
        let page = create_page(&vault, "Original", "general", "Content", false).unwrap();
        let dup = duplicate_page(&vault, &page.path).unwrap();

        assert_eq!(dup.meta.title, "Original (Copy)");
        assert_ne!(dup.meta.id, page.meta.id);
        assert_eq!(dup.content, "Content");
        assert_ne!(dup.path, page.path);
    }

    #[test]
    fn toggle_pin_works() {
        let (_dir, vault) = setup_vault();
        let page = create_page(&vault, "Pin Test", "general", "", false).unwrap();
        assert!(!page.meta.pinned);

        let pinned = toggle_pin(&vault, &page.path).unwrap();
        assert!(pinned.meta.pinned);

        let unpinned = toggle_pin(&vault, &page.path).unwrap();
        assert!(!unpinned.meta.pinned);
    }

    #[test]
    fn list_pages_sorted() {
        let (_dir, vault) = setup_vault();
        create_page(&vault, "First", "general", "a", false).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(10));
        let second = create_page(&vault, "Second", "general", "b", false).unwrap();
        toggle_pin(&vault, &second.path).unwrap();

        let pages = list_pages(&vault).unwrap();
        assert_eq!(pages.len(), 2);
        // Pinned page should be first
        assert_eq!(pages[0].meta.title, "Second");
        assert!(pages[0].meta.pinned);
    }

    #[test]
    fn move_page_changes_folder() {
        let (_dir, vault) = setup_vault();
        let page = create_page(&vault, "Movable", "general", "content", false).unwrap();

        let moved = move_page(&vault, &page.path, "credentials").unwrap();
        assert_eq!(moved.meta.folder, "credentials");
        assert!(moved.path.starts_with("credentials/"));
        assert!(!vault.join(&page.path).exists());
        assert!(vault.join(&moved.path).exists());
    }

    #[test]
    fn read_nonexistent_page_fails() {
        let (_dir, vault) = setup_vault();
        let result = read_page(&vault, "general/does-not-exist.md");
        assert!(result.is_err());
    }

    #[test]
    fn create_page_disambiguates_same_title_same_second() {
        let (_dir, vault) = setup_vault();
        // Same title created back-to-back (same second, same slug) must NOT
        // overwrite — each gets a distinct file and both survive.
        let a = create_page(&vault, "Duplicate", "general", "first", false).unwrap();
        let b = create_page(&vault, "Duplicate", "general", "second", false).unwrap();
        assert_ne!(a.path, b.path, "second page must get a distinct filename");
        assert_eq!(read_page(&vault, &a.path).unwrap().content.trim(), "first");
        assert_eq!(read_page(&vault, &b.path).unwrap().content.trim(), "second");
        assert_eq!(list_pages(&vault).unwrap().len(), 2);
    }

    #[test]
    fn list_pages_skips_hidden_dirs() {
        let (_dir, vault) = setup_vault();
        // Create a page in normal folder
        create_page(&vault, "Visible", "general", "yes", false).unwrap();

        // Create a file in .securenotes (should be skipped)
        let hidden = vault.join(".securenotes");
        std::fs::create_dir_all(&hidden).unwrap();
        std::fs::write(hidden.join("fake.md"), "---\nid: x\ntitle: hidden\ncreated_at: 2026-01-01T00:00:00Z\nupdated_at: 2026-01-01T00:00:00Z\n---\n").unwrap();

        let pages = list_pages(&vault).unwrap();
        assert_eq!(pages.len(), 1);
        assert_eq!(pages[0].meta.title, "Visible");
    }

    #[test]
    fn path_traversal_rejected() {
        let (_dir, vault) = setup_vault();
        // Attempt to escape the vault with ..
        assert!(read_page(&vault, "../../../etc/passwd").is_err());
        assert!(create_page(&vault, "Evil", "../outside", "pwned", false).is_err());
        assert!(move_page(&vault, "general/fake.md", "../../escape").is_err());
    }

    #[test]
    fn list_folders_returns_all_dirs_recursively() {
        let (_dir, vault) = setup_vault();
        std::fs::create_dir_all(vault.join("credentials")).unwrap();
        std::fs::create_dir_all(vault.join("credentials/work")).unwrap();
        std::fs::create_dir_all(vault.join("work")).unwrap();
        std::fs::create_dir_all(vault.join(".securenotes")).unwrap();
        std::fs::create_dir_all(vault.join(".git")).unwrap();

        let folders = list_folders(&vault).unwrap();
        assert!(folders.contains(&"general".to_string()));
        assert!(folders.contains(&"credentials".to_string()));
        assert!(folders.contains(&"credentials/work".to_string()));
        assert!(folders.contains(&"work".to_string()));
        assert!(!folders.contains(&".securenotes".to_string()));
        assert!(!folders.contains(&".git".to_string()));
    }

    #[test]
    fn create_folder_succeeds() {
        let (_dir, vault) = setup_vault();
        let name = create_folder(&vault, "credentials").unwrap();
        assert_eq!(name, "credentials");
        assert!(vault.join("credentials").is_dir());
    }

    #[test]
    fn create_folder_rejects_duplicates() {
        let (_dir, vault) = setup_vault();
        create_folder(&vault, "work").unwrap();
        assert!(create_folder(&vault, "work").is_err());
    }

    #[test]
    fn create_folder_rejects_invalid_names() {
        let (_dir, vault) = setup_vault();
        assert!(create_folder(&vault, "").is_err());
        assert!(create_folder(&vault, "..").is_err());
        assert!(create_folder(&vault, ".securenotes").is_err());
        assert!(create_folder(&vault, ".git").is_err());
        assert!(create_folder(&vault, ".hidden").is_err());
    }

    #[test]
    fn rename_folder_moves_dir_and_updates_pages() {
        let (_dir, vault) = setup_vault();
        create_page(&vault, "Note", "work", "content", false).unwrap();

        rename_folder(&vault, "work", "projects").unwrap();
        assert!(!vault.join("work").exists());
        assert!(vault.join("projects").is_dir());

        let pages = list_pages(&vault).unwrap();
        let page = pages.iter().find(|p| p.meta.title == "Note").unwrap();
        assert_eq!(page.meta.folder, "projects");
        assert!(page.path.starts_with("projects/"));
    }

    #[test]
    fn rename_folder_rejects_general() {
        let (_dir, vault) = setup_vault();
        assert!(rename_folder(&vault, "general", "other").is_err());
    }

    #[test]
    fn rename_folder_rejects_duplicate_target() {
        let (_dir, vault) = setup_vault();
        create_folder(&vault, "work").unwrap();
        create_folder(&vault, "projects").unwrap();
        assert!(rename_folder(&vault, "work", "projects").is_err());
    }

    #[test]
    fn delete_folder_empty() {
        let (_dir, vault) = setup_vault();
        create_folder(&vault, "empty").unwrap();
        delete_folder(&vault, "empty", "delete_pages").unwrap();
        assert!(!vault.join("empty").exists());
    }

    #[test]
    fn delete_folder_with_pages_delete_action() {
        let (_dir, vault) = setup_vault();
        create_page(&vault, "Doomed", "doomed", "bye", false).unwrap();
        delete_folder(&vault, "doomed", "delete_pages").unwrap();
        assert!(!vault.join("doomed").exists());
        let pages = list_pages(&vault).unwrap();
        assert!(pages.iter().all(|p| p.meta.folder != "doomed"));
    }

    #[test]
    fn delete_folder_with_pages_move_action() {
        let (_dir, vault) = setup_vault();
        create_page(&vault, "Saved", "temp", "keep me", false).unwrap();
        delete_folder(&vault, "temp", "move_pages:general").unwrap();
        assert!(!vault.join("temp").exists());
        let pages = list_pages(&vault).unwrap();
        let page = pages.iter().find(|p| p.meta.title == "Saved").unwrap();
        assert_eq!(page.meta.folder, "general");
    }

    #[test]
    fn delete_folder_rejects_general() {
        let (_dir, vault) = setup_vault();
        assert!(delete_folder(&vault, "general", "delete_pages").is_err());
    }

    #[test]
    fn stress_large_content_1mb() {
        let (_dir, vault) = setup_vault();
        // 1 MB of text (simulates large paste)
        let content = "A".repeat(1_000_000);
        let page = create_page(&vault, "Large Note", "general", &content, false).unwrap();
        let read = read_page(&vault, &page.path).unwrap();
        assert_eq!(read.content.len(), 1_000_000);
    }

    #[test]
    fn stress_large_content_5mb() {
        let (_dir, vault) = setup_vault();
        // 5 MB of text
        let content = "Hello World! ".repeat(400_000); // ~5.2 MB
        let page = create_page(&vault, "Huge Note", "general", &content, false).unwrap();
        let read = read_page(&vault, &page.path).unwrap();
        assert_eq!(read.content, content);
    }

    #[test]
    fn stress_large_content_with_secret_blocks() {
        let (_dir, vault) = setup_vault();
        // Large content with many secret blocks interspersed
        let mut content = String::with_capacity(2_000_000);
        for i in 0..100 {
            content.push_str(&format!("## Section {i}\n\n"));
            content.push_str(&"Some regular text. ".repeat(500));
            content.push_str(&format!(
                "\n\n:::secret[API Key {i}]\nsk-test-{i}-{}\n:::\n\n",
                "x".repeat(1000)
            ));
        }
        let page = create_page(&vault, "Secrets Stress", "general", &content, false).unwrap();
        let read = read_page(&vault, &page.path).unwrap();
        assert_eq!(read.content.len(), content.len());
    }

    #[test]
    fn stress_rapid_updates_large_content() {
        let (_dir, vault) = setup_vault();
        let page = create_page(&vault, "Rapid", "general", "initial", false).unwrap();
        // Simulate rapid large updates (like typing fast or pasting repeatedly)
        for i in 0..50 {
            let content = format!("Update {i}: {}", "B".repeat(100_000));
            update_page(&vault, &page.path, &content).unwrap();
        }
        let read = read_page(&vault, &page.path).unwrap();
        assert!(read.content.starts_with("Update 49:"));
    }

    #[test]
    fn create_nested_folder() {
        let (_dir, vault) = setup_vault();
        let name = create_folder(&vault, "work/aws").unwrap();
        assert_eq!(name, "work/aws");
        assert!(vault.join("work/aws").is_dir());
        // Intermediate directory also created
        assert!(vault.join("work").is_dir());
    }

    #[test]
    fn create_folder_in_nested_parent() {
        let (_dir, vault) = setup_vault();
        // Creating a/b/c when a/b doesn't exist yet
        let name = create_folder(&vault, "a/b/c").unwrap();
        assert_eq!(name, "a/b/c");
        assert!(vault.join("a/b/c").is_dir());
    }

    #[test]
    fn list_folders_includes_nested() {
        let (_dir, vault) = setup_vault();
        create_folder(&vault, "credentials").unwrap();
        create_folder(&vault, "credentials/work").unwrap();
        create_folder(&vault, "credentials/work/aws").unwrap();
        create_folder(&vault, "personal").unwrap();

        let folders = list_folders(&vault).unwrap();
        assert!(folders.contains(&"credentials".to_string()));
        assert!(folders.contains(&"credentials/work".to_string()));
        assert!(folders.contains(&"credentials/work/aws".to_string()));
        assert!(folders.contains(&"personal".to_string()));
        assert!(folders.contains(&"general".to_string()));
    }

    #[test]
    fn rename_nested_folder_cascades() {
        let (_dir, vault) = setup_vault();
        // Create nested structure with pages
        create_page(&vault, "Root Note", "credentials", "root", false).unwrap();
        create_page(&vault, "Work Note", "credentials/work", "work", false).unwrap();

        rename_folder(&vault, "credentials", "logins").unwrap();

        assert!(!vault.join("credentials").exists());
        assert!(vault.join("logins").is_dir());
        assert!(vault.join("logins/work").is_dir());

        let pages = list_pages(&vault).unwrap();
        let root_note = pages.iter().find(|p| p.meta.title == "Root Note").unwrap();
        assert_eq!(root_note.meta.folder, "logins");

        let work_note = pages.iter().find(|p| p.meta.title == "Work Note").unwrap();
        assert_eq!(work_note.meta.folder, "logins/work");
    }

    #[test]
    fn delete_nested_folder_with_pages() {
        let (_dir, vault) = setup_vault();
        create_page(&vault, "Deep Note", "work/aws/prod", "deep", false).unwrap();
        create_page(&vault, "Mid Note", "work/aws", "mid", false).unwrap();

        delete_folder(&vault, "work", "move_pages:general").unwrap();

        assert!(!vault.join("work").exists());
        let pages = list_pages(&vault).unwrap();
        assert!(pages.iter().all(|p| p.meta.folder == "general"));
        assert_eq!(pages.len(), 2);
    }

    #[test]
    fn move_page_to_nested_folder() {
        let (_dir, vault) = setup_vault();
        let page = create_page(&vault, "Movable", "general", "content", false).unwrap();

        let moved = move_page(&vault, &page.path, "work/aws").unwrap();
        assert_eq!(moved.meta.folder, "work/aws");
        assert!(moved.path.starts_with("work/aws/"));
    }

    #[test]
    fn validate_folder_path_rejects_bad_paths() {
        assert!(validate_folder_path("").is_err());
        assert!(validate_folder_path("..").is_err());
        assert!(validate_folder_path("a/../b").is_err());
        assert!(validate_folder_path("/leading").is_err());
        assert!(validate_folder_path("trailing/").is_err());
        assert!(validate_folder_path("a//b").is_err());
        assert!(validate_folder_path("./foo").is_err());
        assert!(validate_folder_path(".hidden/sub").is_err());
        assert!(validate_folder_path("a/.hidden").is_err());
    }

    #[test]
    fn validate_folder_path_accepts_nested() {
        assert!(validate_folder_path("work").is_ok());
        assert!(validate_folder_path("work/aws").is_ok());
        assert!(validate_folder_path("work/aws/production").is_ok());
    }

    #[test]
    fn rename_general_subfolder_allowed() {
        let (_dir, vault) = setup_vault();
        // general itself can't be renamed, but general/sub can (if it existed)
        // However, per the plan general/X starts with "general/" — let's verify the protection
        assert!(rename_folder(&vault, "general", "other").is_err());
        assert!(rename_folder(&vault, "general/sub", "general/other").is_err());
    }

    /// Deleting a folder must never reach the vault's own internals.
    ///
    /// `delete_folder` validated only that the path stayed inside the vault and
    /// named a directory, then called `remove_dir_all`. `.securenotes` satisfied
    /// both, so a single call destroyed `vault.key` — the encrypted master key —
    /// making every secret in the vault permanently unrecoverable. Reachable
    /// over the local API by a Notes-scope token, which cannot even read those
    /// secrets: `list_pages` skips dot-directories, so the route's
    /// "does this folder hold secrets?" check saw an empty list and allowed it.
    #[test]
    fn delete_folder_refuses_vault_internals() {
        let (_dir, vault) = setup_vault();

        let internals = vault.join(".securenotes");
        std::fs::create_dir_all(&internals).unwrap();
        std::fs::write(internals.join("vault.key"), b"encrypted-master-key").unwrap();

        assert!(
            delete_folder(&vault, ".securenotes", "delete_pages").is_err(),
            "deleting .securenotes must be refused"
        );
        assert!(
            internals.join("vault.key").exists(),
            "vault.key was destroyed — every secret is now unrecoverable"
        );

        // Same route, same consequence for the version history.
        let git = vault.join(".git");
        std::fs::create_dir_all(git.join("objects")).unwrap();
        assert!(
            delete_folder(&vault, ".git", "delete_pages").is_err(),
            "deleting .git must be refused"
        );
        assert!(git.join("objects").exists(), "git history was destroyed");

        // The move_pages branch removes the source tree too, so it needs the
        // same guard.
        assert!(
            delete_folder(&vault, ".securenotes", "move_pages:general").is_err(),
            "the move_pages branch must be refused as well"
        );
        assert!(internals.join("vault.key").exists());
    }

    /// A page must not be movable into a dot-directory. `create_folder` and
    /// `rename_folder` both reject hidden segments; `move_page` validated only
    /// that the destination stayed inside the vault, which let an API caller
    /// drop attacker-controlled files into `.securenotes` or `.git`.
    #[test]
    fn move_page_refuses_hidden_destination_folders() {
        let (_dir, vault) = setup_vault();
        std::fs::create_dir_all(vault.join(".securenotes")).unwrap();

        let page = create_page(&vault, "Movable", "general", "content", false).unwrap();

        assert!(
            move_page(&vault, &page.path, ".securenotes").is_err(),
            "moving a page into .securenotes must be refused"
        );
        assert!(
            move_page(&vault, &page.path, ".git/hooks").is_err(),
            "moving a page into .git must be refused"
        );
        assert!(
            vault.join(&page.path).exists(),
            "the page should be untouched after a refused move"
        );
    }

    /// Creating a page must refuse a dot-directory, whichever caller asks.
    ///
    /// The local API route ran its own check, but the MCP server's direct-vault
    /// mode called straight through with a caller-supplied folder, so an agent
    /// could drop pages into `.securenotes` or `.git`.
    #[test]
    fn create_page_refuses_hidden_folders() {
        let (_dir, vault) = setup_vault();

        for folder in [
            ".securenotes",
            ".git",
            ".git/hooks",
            "work/.hidden",
            ".agent/proj",
        ] {
            assert!(
                create_page(&vault, "Sneaky", folder, "body", false).is_err(),
                "creating a page in {folder:?} should be refused"
            );
            assert!(
                !vault.join(folder).exists(),
                "{folder:?} should not have been created"
            );
        }

        // Ordinary folders, including nested ones, still work.
        for folder in ["general", "credentials", "work/aws/prod"] {
            create_page(&vault, "Fine", folder, "body", false)
                .unwrap_or_else(|e| panic!("creating a page in {folder:?} should work: {e}"));
        }
    }
}
