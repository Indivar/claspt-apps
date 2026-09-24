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
//!
//! Two tiers of journal live here. Plain JSON (`read`/`write`/`append`) holds
//! bookkeeping that says nothing about any secret: device names, import
//! counts, automation rules, approval grants. Sealed JSON (`read_sealed`/
//! `write_sealed`/`append_sealed`) holds the journals that *describe* secrets:
//! the password-health lists of which credentials are weak, reused or breached;
//! the usernames the extension filled and where; template defaults; the
//! share log's recipients. Owner-only file permissions were the only thing
//! protecting those, and a vault directory copied into a backup, or read by
//! any process running as the user, handed over a targeted map of the weakest
//! credentials without touching a single encrypted block. A sealed journal is
//! one `enc:v1:` blob under the master key, the same AES-256-GCM seal a secret
//! block gets, so it is exactly as readable as the secrets it describes and no
//! more. A journal written before sealing existed is plain JSON; it is read as
//! such and sealed on its next write, so nothing is lost and no migration step
//! is needed.

use serde::{de::DeserializeOwned, Serialize};
use std::path::{Path, PathBuf};

/// Prefix of a sealed journal file, shared with secret blocks so the two are
/// recognisably the same construction.
const SEALED_PREFIX: &str = "enc:v1:";

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

    // ── sealed journals ─────────────────────────────────────────────────

    /// The JSON inside a journal file, whether it is sealed or a plain file
    /// from before sealing existed. `None` when the file is absent, or is
    /// sealed under a key that is not this vault's.
    fn read_journal_json(path: &Path, master_key: &[u8]) -> Option<String> {
        let content = std::fs::read_to_string(path).ok()?;
        let trimmed = content.trim();
        match trimmed.strip_prefix(SEALED_PREFIX) {
            Some(blob) => claspt_core::crypto::vault_key::decrypt_block(master_key, blob)
                .ok()
                .map(|plain| plain.to_string()),
            None => Some(content),
        }
    }

    /// Seal `json` under the master key in the on-disk form.
    fn seal_json(json: &str, master_key: &[u8]) -> std::io::Result<String> {
        let blob = claspt_core::crypto::vault_key::encrypt_block(master_key, json)
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        Ok(format!("{SEALED_PREFIX}{blob}"))
    }

    /// Read a sealed journal. Returns the default when the file is absent,
    /// unreadable, or sealed under another key.
    pub fn read_sealed<T: DeserializeOwned + Default>(
        vault_dir: &Path,
        filename: &str,
        master_key: &[u8],
    ) -> T {
        let path = Self::dir(vault_dir).join(filename);
        match Self::read_journal_json(&path, master_key) {
            Some(json) => serde_json::from_str(&json).unwrap_or_default(),
            None => T::default(),
        }
    }

    /// Write a sealed journal: the JSON is one `enc:v1:` blob on disk.
    pub fn write_sealed<T: Serialize>(
        vault_dir: &Path,
        filename: &str,
        data: &T,
        master_key: &[u8],
    ) -> std::io::Result<()> {
        Self::ensure_dir(vault_dir)?;
        let path = Self::dir(vault_dir).join(filename);
        let json = serde_json::to_string(data).map_err(std::io::Error::other)?;
        let sealed = Self::seal_json(&json, master_key)?;
        Self::write_bytes(&path, sealed.as_bytes())
    }

    /// Append to a sealed JSON array journal, keeping at most `max_entries`.
    pub fn append_sealed<T: Serialize + DeserializeOwned>(
        vault_dir: &Path,
        filename: &str,
        entry: &T,
        max_entries: usize,
        master_key: &[u8],
    ) -> std::io::Result<()> {
        Self::ensure_dir(vault_dir)?;
        let path = Self::dir(vault_dir).join(filename);

        let mut entries: Vec<serde_json::Value> = Self::read_journal_json(&path, master_key)
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default();

        let value = serde_json::to_value(entry).map_err(std::io::Error::other)?;
        entries.push(value);
        if entries.len() > max_entries {
            entries = entries.split_off(entries.len() - max_entries);
        }

        let json = serde_json::to_string(&entries).map_err(std::io::Error::other)?;
        let sealed = Self::seal_json(&json, master_key)?;
        Self::write_bytes(&path, sealed.as_bytes())
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

    const KEY: [u8; 32] = [9u8; 32];

    #[test]
    fn sealed_journals_round_trip_and_hold_no_plaintext() {
        let dir = tempdir().unwrap();
        let vault = dir.path();
        let data = vec![
            "alice@example.com".to_string(),
            "weak-credential".to_string(),
        ];
        InternalStore::write_sealed(vault, "sealed.json", &data, &KEY).unwrap();

        let on_disk =
            std::fs::read_to_string(InternalStore::dir(vault).join("sealed.json")).unwrap();
        assert!(
            on_disk.starts_with("enc:v1:"),
            "journal is not sealed: {on_disk}"
        );
        assert!(!on_disk.contains("alice"), "journal leaks plaintext");
        assert!(!on_disk.contains("weak"), "journal leaks plaintext");

        let back: Vec<String> = InternalStore::read_sealed(vault, "sealed.json", &KEY);
        assert_eq!(back, data);
    }

    #[test]
    fn a_sealed_journal_under_another_key_reads_as_empty() {
        let dir = tempdir().unwrap();
        let vault = dir.path();
        InternalStore::write_sealed(vault, "sealed.json", &vec!["x".to_string()], &KEY).unwrap();
        let other = [1u8; 32];
        let back: Vec<String> = InternalStore::read_sealed(vault, "sealed.json", &other);
        assert!(back.is_empty());
    }

    /// A journal written by a build that predates sealing is plain JSON. It is
    /// read as it is, and the first write after that seals it.
    #[test]
    fn a_legacy_plain_journal_is_read_and_sealed_on_the_next_write() {
        let dir = tempdir().unwrap();
        let vault = dir.path();
        InternalStore::ensure_dir(vault).unwrap();
        let path = InternalStore::dir(vault).join("log.json");
        std::fs::write(&path, r#"["old-entry"]"#).unwrap();

        let back: Vec<String> = InternalStore::read_sealed(vault, "log.json", &KEY);
        assert_eq!(back, vec!["old-entry".to_string()]);

        InternalStore::append_sealed(vault, "log.json", &"new-entry".to_string(), 10, &KEY)
            .unwrap();
        let on_disk = std::fs::read_to_string(&path).unwrap();
        assert!(on_disk.starts_with("enc:v1:"));
        assert!(!on_disk.contains("old-entry"));
        let back: Vec<String> = InternalStore::read_sealed(vault, "log.json", &KEY);
        assert_eq!(back, vec!["old-entry".to_string(), "new-entry".to_string()]);
    }

    #[test]
    fn sealed_append_keeps_only_the_most_recent_entries() {
        let dir = tempdir().unwrap();
        for i in 0..10 {
            InternalStore::append_sealed(dir.path(), "log.json", &i, 5, &KEY).unwrap();
        }
        let result: Vec<i32> = InternalStore::read_sealed(dir.path(), "log.json", &KEY);
        assert_eq!(result, vec![5, 6, 7, 8, 9]);
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
