// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Generic read/write for internal JSON pages in `.securenotes/internal/`.
//!
//! Everything here is metadata about secrets rather than secrets themselves —
//! which credential was used, when, and on what domain; which are weak or
//! reused; what has been shared and with whom. That is sensitive enough to
//! deserve the same owner-only treatment as the rest of `.securenotes/`, so
//! writes go through [`crate::vault::init::write_restricted`] rather than
//! `std::fs::write`, which would apply the process umask and leave the files
//! world-readable on a typical system.

use serde::{de::DeserializeOwned, Serialize};
use std::path::{Path, PathBuf};

/// Low-level store for internal system pages.
pub struct InternalStore;

impl InternalStore {
    /// Get the internal directory path for a vault.
    pub fn dir(vault_dir: &Path) -> PathBuf {
        vault_dir.join(".securenotes").join("internal")
    }

    /// Ensure the internal directory exists, restricted to the owner.
    ///
    /// The listing alone reveals which features are in use, so the directory is
    /// narrowed as well as the files inside it.
    pub fn ensure_dir(vault_dir: &Path) -> std::io::Result<()> {
        let dir = Self::dir(vault_dir);
        std::fs::create_dir_all(&dir)?;
        claspt_core::fs_perms::restrict_to_owner(&dir)?;
        Ok(())
    }

    /// Write bytes to a file in the internal store, owner-only.
    ///
    /// Shares [`crate::vault::init::write_restricted`] with the rest of the
    /// vault rather than repeating the permission handling, so the two cannot
    /// drift apart. That helper also writes atomically via a temporary file,
    /// which keeps a crash mid-write from truncating a journal.
    fn write_bytes(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
        crate::vault::init::write_restricted(path, bytes)
            .map_err(|e| std::io::Error::other(e.to_string()))
    }

    /// Read a JSON file from the internal store. Returns default if file doesn't exist.
    pub fn read<T: DeserializeOwned + Default>(vault_dir: &Path, filename: &str) -> T {
        let path = Self::dir(vault_dir).join(filename);
        match std::fs::read_to_string(&path) {
            Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
            Err(_) => T::default(),
        }
    }

    /// Write a JSON file to the internal store.
    pub fn write<T: Serialize>(vault_dir: &Path, filename: &str, data: &T) -> std::io::Result<()> {
        Self::ensure_dir(vault_dir)?;
        let path = Self::dir(vault_dir).join(filename);
        let json = serde_json::to_string_pretty(data).map_err(std::io::Error::other)?;
        Self::write_bytes(&path, json.as_bytes())
    }

    /// Append an entry to a JSON array file. Creates the file if it doesn't exist.
    /// Keeps at most `max_entries` (removes oldest from the front).
    pub fn append<T: Serialize + DeserializeOwned>(
        vault_dir: &Path,
        filename: &str,
        entry: &T,
        max_entries: usize,
    ) -> std::io::Result<()> {
        Self::ensure_dir(vault_dir)?;
        let path = Self::dir(vault_dir).join(filename);

        let mut entries: Vec<serde_json::Value> = match std::fs::read_to_string(&path) {
            Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
            Err(_) => Vec::new(),
        };

        let value = serde_json::to_value(entry).map_err(std::io::Error::other)?;
        entries.push(value);

        // Trim to max size (keep most recent)
        if entries.len() > max_entries {
            entries = entries.split_off(entries.len() - max_entries);
        }

        let json = serde_json::to_string_pretty(&entries).map_err(std::io::Error::other)?;
        Self::write_bytes(&path, json.as_bytes())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn read_missing_file_returns_default() {
        let dir = tempdir().unwrap();
        let result: Vec<String> = InternalStore::read(dir.path(), "nonexistent.json");
        assert!(result.is_empty());
    }

    #[test]
    fn write_and_read_roundtrip() {
        let dir = tempdir().unwrap();
        let data = vec!["hello".to_string(), "world".to_string()];
        InternalStore::write(dir.path(), "test.json", &data).unwrap();
        let result: Vec<String> = InternalStore::read(dir.path(), "test.json");
        assert_eq!(result, data);
    }

    #[test]
    fn append_with_max_entries() {
        let dir = tempdir().unwrap();
        for i in 0..10 {
            InternalStore::append(dir.path(), "log.json", &i, 5).unwrap();
        }
        let result: Vec<i32> = InternalStore::read(dir.path(), "log.json");
        assert_eq!(result, vec![5, 6, 7, 8, 9]);
    }

    /// Everything in this directory is vault metadata about secrets: which
    /// credential was used, when, and on what domain; which are weak or reused;
    /// what has been shared with whom. It must be no more readable than the
    /// vault's other internals, all of which are written owner-only.
    ///
    /// Both writers used `std::fs::write`, which applies the process umask —
    /// world-readable on a typical system.
    #[cfg(unix)]
    #[test]
    fn internal_files_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempdir().unwrap();
        let vault = dir.path();

        InternalStore::write(vault, "written.json", &vec!["a".to_string()]).unwrap();
        InternalStore::append(vault, "appended.json", &"entry".to_string(), 10).unwrap();

        for name in ["written.json", "appended.json"] {
            let path = InternalStore::dir(vault).join(name);
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(
                mode, 0o600,
                "{name} is mode {mode:o}, readable beyond the owner"
            );
        }

        // The directory listing alone reveals which features are in use, so it
        // is restricted too.
        let dir_mode = std::fs::metadata(InternalStore::dir(vault))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(dir_mode, 0o700, "internal dir is mode {dir_mode:o}");
    }

    /// Rewriting an existing file must not leave it more readable than it was.
    #[cfg(unix)]
    #[test]
    fn rewriting_an_existing_file_keeps_it_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempdir().unwrap();
        let vault = dir.path();
        InternalStore::write(vault, "test.json", &vec!["first".to_string()]).unwrap();

        let path = InternalStore::dir(vault).join("test.json");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();

        InternalStore::write(vault, "test.json", &vec!["second".to_string()]).unwrap();

        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "rewrite left the file at mode {mode:o}");
    }
}
