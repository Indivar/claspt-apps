// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! The vault's recycle bin.
//!
//! A deleted page waits here until the owner restores it or its time is
//! up; nothing is ever removed on the spot. Only deletion comes here: an
//! edit keeps its history in git, as before. The entry is the page file
//! exactly as it was, secrets still encrypted, under `.securenotes/trash/`,
//! which is owner-only, never synced and never indexed; git records the
//! removal as it always did, so a purged page is still in the history.
//! Pages older than the vault's retention (7 to 90 days, 30 to start) are
//! purged on unlock.

use std::path::{Path, PathBuf};

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

use super::crud::{atomic_write, safe_page_path};
use super::error::PageError;
use super::model;

/// Where the entries live, inside the device-local metadata directory.
pub const TRASH_DIR: &str = ".securenotes/trash";
pub const DEFAULT_RETENTION_DAYS: u32 = 30;
pub const MIN_RETENTION_DAYS: u32 = 7;
pub const MAX_RETENTION_DAYS: u32 = 90;

/// A page in the trash, as the Trash view shows it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TrashEntry {
    pub id: String,
    /// Where the page was, vault-relative; restore puts it back there.
    pub original_path: String,
    pub title: String,
    pub folder: String,
    pub encrypted: bool,
    pub deleted_at: DateTime<Utc>,
    /// When the unlock-time purge will remove it, under the current retention.
    pub purge_at: DateTime<Utc>,
}

/// What is written beside the page file.
#[derive(Serialize, Deserialize)]
struct Record {
    original_path: String,
    title: String,
    folder: String,
    encrypted: bool,
    deleted_at: DateTime<Utc>,
}

fn trash_dir(vault_dir: &Path) -> PathBuf {
    vault_dir.join(TRASH_DIR)
}

fn ensure_dir(vault_dir: &Path) -> Result<PathBuf, PageError> {
    let dir = trash_dir(vault_dir);
    std::fs::create_dir_all(&dir)?;
    claspt_core::fs_perms::restrict_to_owner(&dir)?;
    Ok(dir)
}

fn record_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.json"))
}

fn page_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.md"))
}

/// An id that sorts by deletion time and cannot escape the trash directory.
fn entry_id(deleted_at: &DateTime<Utc>, page_id: &str) -> String {
    let safe: String = page_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(48)
        .collect();
    format!(
        "{}-{}",
        deleted_at.timestamp_millis(),
        if safe.is_empty() { "page" } else { &safe }
    )
}

fn valid_id(id: &str) -> Result<(), PageError> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(PageError::Trash(format!("not a trash entry id: {id}")));
    }
    Ok(())
}

fn retention(days: u32) -> Duration {
    Duration::days(i64::from(
        days.clamp(MIN_RETENTION_DAYS, MAX_RETENTION_DAYS),
    ))
}

/// The vault's retention, from its config; the default when unreadable.
pub fn retention_for(vault_dir: &Path) -> u32 {
    crate::vault::init::read_config(vault_dir)
        .map(|c| c.trash_retention_days)
        .unwrap_or(DEFAULT_RETENTION_DAYS)
}

/// Move the page at `rel_path` into the trash. The file goes in as it is.
pub fn move_to_trash(
    vault_dir: &Path,
    rel_path: &str,
    retention_days: u32,
) -> Result<TrashEntry, PageError> {
    let file = safe_page_path(vault_dir, rel_path)?;
    if !file.is_file() {
        return Err(PageError::NotFound(rel_path.to_string()));
    }
    let raw = std::fs::read(&file)?;
    let deleted_at = Utc::now();
    // A page whose frontmatter will not parse is still a page the owner may
    // want back; it is named by its file and filed under its folder.
    let (title, folder, encrypted, page_id) = match std::str::from_utf8(&raw)
        .ok()
        .and_then(|text| model::parse_page(text).ok())
    {
        Some((meta, _)) => (meta.title, meta.folder, meta.encrypted, meta.id),
        None => (
            file.file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default(),
            rel_path
                .rsplit_once('/')
                .map(|(f, _)| f.to_string())
                .unwrap_or_default(),
            false,
            String::new(),
        ),
    };
    let id = entry_id(&deleted_at, &page_id);
    let dir = ensure_dir(vault_dir)?;
    let record = Record {
        original_path: rel_path.to_string(),
        title: title.clone(),
        folder: folder.clone(),
        encrypted,
        deleted_at,
    };
    claspt_core::fs_perms::write_owner_only(&page_path(&dir, &id), &raw)?;
    let record_json =
        serde_json::to_string(&record).map_err(|e| PageError::Trash(e.to_string()))?;
    claspt_core::fs_perms::write_owner_only(&record_path(&dir, &id), record_json.as_bytes())?;
    std::fs::remove_file(&file)?;
    Ok(TrashEntry {
        id,
        original_path: rel_path.to_string(),
        title,
        folder,
        encrypted,
        deleted_at,
        purge_at: deleted_at + retention(retention_days),
    })
}

/// Every entry, newest first.
pub fn list(vault_dir: &Path, retention_days: u32) -> Result<Vec<TrashEntry>, PageError> {
    let dir = trash_dir(vault_dir);
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let keep = retention(retention_days);
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&dir)? {
        let path = entry?.path();
        if path.extension().is_none_or(|e| e != "json") {
            continue;
        }
        let Some(id) = path.file_stem().map(|s| s.to_string_lossy().to_string()) else {
            continue;
        };
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(record) = serde_json::from_str::<Record>(&text) else {
            continue;
        };
        entries.push(TrashEntry {
            id,
            original_path: record.original_path,
            title: record.title,
            folder: record.folder,
            encrypted: record.encrypted,
            deleted_at: record.deleted_at,
            purge_at: record.deleted_at + keep,
        });
    }
    entries.sort_by_key(|e| std::cmp::Reverse(e.deleted_at));
    Ok(entries)
}

/// Put a page back. It returns to where it was; if another page has taken
/// that name since, it comes back beside it under a fresh file name, in
/// the same folder (recreated if it went). Returns the page's path.
pub fn restore(vault_dir: &Path, id: &str) -> Result<String, PageError> {
    valid_id(id)?;
    let dir = trash_dir(vault_dir);
    let record_json = std::fs::read_to_string(record_path(&dir, id))
        .map_err(|_| PageError::Trash(format!("no trash entry {id}")))?;
    let record: Record =
        serde_json::from_str(&record_json).map_err(|e| PageError::Trash(e.to_string()))?;
    let raw = std::fs::read(page_path(&dir, id))?;
    let mut rel = record.original_path.clone();
    let mut target = safe_page_path(vault_dir, &rel)?;
    if target.exists() {
        // A fresh name in the same folder; the second-resolution timestamp
        // can collide with a page made moments ago, so count up until free.
        let folder = rel
            .rsplit_once('/')
            .map(|(f, _)| f.to_string())
            .unwrap_or_default();
        let base = model::generate_filename(&record.title, &Utc::now());
        let stem = base.strip_suffix(".md").unwrap_or(&base).to_string();
        let mut n = 1;
        loop {
            let name = if n == 1 {
                base.clone()
            } else {
                format!("{stem}-{n}.md")
            };
            rel = if folder.is_empty() {
                name
            } else {
                format!("{folder}/{name}")
            };
            target = safe_page_path(vault_dir, &rel)?;
            if !target.exists() {
                break;
            }
            n += 1;
        }
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    atomic_write(&target, &raw)?;
    purge(vault_dir, id)?;
    Ok(rel)
}

/// Remove one entry for good; already gone counts as done.
pub fn purge(vault_dir: &Path, id: &str) -> Result<(), PageError> {
    valid_id(id)?;
    let dir = trash_dir(vault_dir);
    for path in [page_path(&dir, id), record_path(&dir, id)] {
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}

/// Remove every entry. Returns how many pages went.
pub fn empty(vault_dir: &Path, retention_days: u32) -> Result<usize, PageError> {
    let entries = list(vault_dir, retention_days)?;
    for entry in &entries {
        purge(vault_dir, &entry.id)?;
    }
    Ok(entries.len())
}

/// Remove every entry whose time is up at `now`. Returns how many went.
pub fn purge_expired(
    vault_dir: &Path,
    retention_days: u32,
    now: DateTime<Utc>,
) -> Result<usize, PageError> {
    let mut count = 0;
    for entry in list(vault_dir, retention_days)? {
        if entry.purge_at <= now {
            purge(vault_dir, &entry.id)?;
            count += 1;
        }
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault_with_page() -> (tempfile::TempDir, PathBuf, String) {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path().to_path_buf();
        std::fs::create_dir_all(vault.join("general")).unwrap();
        std::fs::create_dir_all(vault.join(".securenotes")).unwrap();
        let page = super::super::crud::create_page(
            &vault,
            "Plan",
            "general",
            "body\n\n:::secret[k]\nenc:v1:AAAA\n:::\n",
            false,
        )
        .unwrap();
        (dir, vault, page.path)
    }

    #[test]
    fn a_deleted_page_waits_in_the_trash_as_it_was_and_comes_back_whole() {
        let (_dir, vault, path) = vault_with_page();
        let original = std::fs::read(vault.join(&path)).unwrap();
        let entry = move_to_trash(&vault, &path, 30).unwrap();
        assert!(!vault.join(&path).exists());
        assert_eq!(entry.title, "Plan");
        assert_eq!(entry.folder, "general");
        assert_eq!(entry.original_path, path);
        assert_eq!(entry.purge_at, entry.deleted_at + Duration::days(30));

        let listed = list(&vault, 30).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, entry.id);
        let kept = std::fs::read(vault.join(TRASH_DIR).join(format!("{}.md", entry.id))).unwrap();
        assert_eq!(kept, original, "bytes untouched, secrets still encrypted");

        let back = restore(&vault, &entry.id).unwrap();
        assert_eq!(back, path);
        assert_eq!(std::fs::read(vault.join(&path)).unwrap(), original);
        assert!(list(&vault, 30).unwrap().is_empty());
    }

    #[test]
    fn restoring_beside_a_page_that_took_the_name_keeps_both() {
        let (_dir, vault, path) = vault_with_page();
        let entry = move_to_trash(&vault, &path, 30).unwrap();
        std::fs::write(vault.join(&path), "---\nid: other\ntitle: Other\ncreated_at: 2026-01-01T00:00:00Z\nupdated_at: 2026-01-01T00:00:00Z\n---\nnewer\n").unwrap();
        let back = restore(&vault, &entry.id).unwrap();
        assert_ne!(back, path);
        assert!(back.starts_with("general/"));
        assert!(vault.join(&path).exists());
        assert!(vault.join(&back).exists());
    }

    #[test]
    fn a_folder_that_went_is_recreated_on_restore() {
        let (_dir, vault, path) = vault_with_page();
        let entry = move_to_trash(&vault, &path, 30).unwrap();
        std::fs::remove_dir_all(vault.join("general")).unwrap();
        let back = restore(&vault, &entry.id).unwrap();
        assert!(vault.join(&back).exists());
    }

    #[test]
    fn expired_entries_go_on_purge_and_the_rest_stay() {
        let (_dir, vault, path) = vault_with_page();
        let entry = move_to_trash(&vault, &path, 7).unwrap();
        let later = entry.deleted_at + Duration::days(7) - Duration::seconds(1);
        assert_eq!(purge_expired(&vault, 7, later).unwrap(), 0);
        assert_eq!(
            purge_expired(&vault, 7, later + Duration::seconds(2)).unwrap(),
            1
        );
        assert!(list(&vault, 7).unwrap().is_empty());
        assert!(restore(&vault, &entry.id).is_err(), "gone is gone");
    }

    #[test]
    fn retention_is_clamped_and_ids_cannot_leave_the_directory() {
        assert_eq!(retention(1), Duration::days(7));
        assert_eq!(retention(400), Duration::days(90));
        let dir = tempfile::tempdir().unwrap();
        assert!(purge(dir.path(), "../../vault.key").is_err());
        assert!(restore(dir.path(), "").is_err());
    }

    #[test]
    fn empty_removes_everything() {
        let (_dir, vault, path) = vault_with_page();
        move_to_trash(&vault, &path, 30).unwrap();
        let second = super::super::crud::create_page(&vault, "Two", "general", "b", false).unwrap();
        move_to_trash(&vault, &second.path, 30).unwrap();
        assert_eq!(empty(&vault, 30).unwrap(), 2);
        assert!(list(&vault, 30).unwrap().is_empty());
    }

    #[test]
    fn a_page_that_is_not_there_is_reported() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("general")).unwrap();
        assert!(matches!(
            move_to_trash(dir.path(), "general/none.md", 30),
            Err(PageError::NotFound(_))
        ));
    }
}
