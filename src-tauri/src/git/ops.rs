// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Low-level git2 operations over the vault repository.
//!
//! Each function opens the vault's git repo on demand and performs one operation:
//! staging + committing changes ([`commit_changes`]), reading whole-vault or per-file
//! history ([`get_log`], [`get_file_log`]), fetching a file's content at a commit
//! ([`get_file_at_commit`]), diffing a commit against its parent ([`get_commit_diff`]),
//! and restoring a file to an earlier revision ([`restore_file_to_commit`]).
//!
//! Commits are authored as `Claspt <claspt@localhost>` with messages of the form
//! `"Update: {title} — {timestamp}"`. Device-local files (config, keys, tokens, and
//! their `.bak` copies) are unstaged before every commit by [`unstage_device_local`] so
//! secret material never lands in the synced history.
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::error::GitError;

/// A commit entry for version history display.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitEntry {
    /// Full commit hash (hex object id).
    pub oid: String,
    /// Commit message, e.g. `"Update: My Note — 2026-07-04 10:15:00"`.
    pub message: String,
    /// Commit time, in UTC.
    pub timestamp: DateTime<Utc>,
}

/// Device-local files that must never be committed to the vault repo, even for
/// legacy vaults whose `.gitignore` predates a given exclusion. `add_all` honors
/// `.gitignore`, but an older vault may already track (or newly stage)
/// `config.json`, which holds the local-API token and license key. Calling this
/// right after `add_all` stages a removal so the file is untracked going
/// forward; it never touches the working-tree file. Missing entries are no-ops.
pub(crate) fn unstage_device_local(index: &mut git2::Index) {
    // Everything under `.securenotes/` is unstaged, rather than a list of
    // filenames. The list this replaces named six files and missed the licence
    // state (the Ed25519 token, device id and the user's email address) and the
    // whole `internal/` directory holding the plaintext usage journal — both of
    // which were therefore committed and synced to every remote.
    //
    // Scanning the staged entries also covers the `.bak` copies that
    // `write_config` and key recovery leave behind, which carry the same API
    // tokens and encrypted master key as the originals.
    let to_remove: Vec<PathBuf> = index
        .iter()
        .filter_map(|entry| {
            let path = std::str::from_utf8(&entry.path).ok()?;
            path.starts_with(".securenotes/")
                .then(|| PathBuf::from(path))
        })
        .collect();

    for path in to_remove {
        let _ = index.remove_path(&path);
    }
}

/// Commit all changes in the vault repository.
///
/// Stages all modified/added/deleted files and creates a commit
/// with the format: "Update: {title} — {timestamp}"
pub fn commit_changes(vault_dir: &Path, title: &str) -> Result<Option<String>, GitError> {
    let repo = git2::Repository::open(vault_dir)?;

    // Stage all changes
    let mut index = repo.index()?;
    index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)?;
    // Also stage deletions
    index.update_all(["*"].iter(), None)?;
    unstage_device_local(&mut index);
    index.write()?;

    // Check if there are any changes to commit
    let tree_oid = index.write_tree()?;
    let tree = repo.find_tree(tree_oid)?;

    if let Ok(head) = repo.head() {
        let parent_commit = head.peel_to_commit()?;
        let parent_tree = parent_commit.tree()?;

        let diff = repo.diff_tree_to_tree(Some(&parent_tree), Some(&tree), None)?;
        if diff.deltas().count() == 0 {
            return Ok(None); // Nothing to commit
        }
    }

    let now = Utc::now();
    let timestamp = now.format("%Y-%m-%d %H:%M:%S");
    let message = format!("Update: {title} \u{2014} {timestamp}");

    let sig = git2::Signature::now("Claspt", "claspt@localhost")?;

    let parent = if let Ok(head) = repo.head() {
        Some(head.peel_to_commit()?)
    } else {
        None
    };

    let parents: Vec<&git2::Commit> = parent.iter().collect();
    let oid = repo.commit(Some("HEAD"), &sig, &sig, &message, &tree, &parents)?;

    Ok(Some(oid.to_string()))
}

/// Get commit history for the entire vault, limited to `max_count` entries.
pub fn get_log(vault_dir: &Path, max_count: usize) -> Result<Vec<CommitEntry>, GitError> {
    let repo = git2::Repository::open(vault_dir)?;

    let mut revwalk = repo.revwalk()?;
    revwalk.push_head()?;
    revwalk.set_sorting(git2::Sort::TIME)?;

    let mut entries = Vec::new();
    for oid_result in revwalk.take(max_count) {
        let oid = oid_result?;
        let commit = repo.find_commit(oid)?;

        let timestamp =
            DateTime::from_timestamp(commit.time().seconds(), 0).unwrap_or_else(Utc::now);

        entries.push(CommitEntry {
            oid: oid.to_string(),
            message: commit.message().unwrap_or("").to_string(),
            timestamp,
        });
    }

    Ok(entries)
}

/// Get commit history for a specific file path (relative to vault root).
///
/// Compares each commit's tree against its parent to detect file changes.
pub fn get_file_log(
    vault_dir: &Path,
    rel_path: &str,
    max_count: usize,
) -> Result<Vec<CommitEntry>, GitError> {
    let repo = git2::Repository::open(vault_dir)?;
    let file_path = Path::new(rel_path);

    let mut revwalk = repo.revwalk()?;
    revwalk.push_head()?;
    revwalk.set_sorting(git2::Sort::TIME)?;

    let mut entries = Vec::new();

    for oid_result in revwalk {
        let oid = oid_result?;
        let commit = repo.find_commit(oid)?;
        let tree = commit.tree()?;

        let current_blob_id = tree.get_path(file_path).ok().map(|e| e.id());

        // Compare with parent(s)
        let changed = if commit.parent_count() == 0 {
            // Root commit: file changed if it exists
            current_blob_id.is_some()
        } else {
            // Compare with first parent
            let parent = commit.parent(0)?;
            let parent_tree = parent.tree()?;
            let parent_blob_id = parent_tree.get_path(file_path).ok().map(|e| e.id());
            current_blob_id != parent_blob_id
        };

        if changed {
            let timestamp =
                DateTime::from_timestamp(commit.time().seconds(), 0).unwrap_or_else(Utc::now);

            entries.push(CommitEntry {
                oid: oid.to_string(),
                message: commit.message().unwrap_or("").to_string(),
                timestamp,
            });

            if entries.len() >= max_count {
                break;
            }
        }
    }

    Ok(entries)
}

/// Diff between a commit and its parent for a specific file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitDiff {
    /// Full commit hash (hex object id) being diffed.
    pub oid: String,
    /// Message of the commit being diffed.
    pub message: String,
    /// Commit time, in UTC.
    pub timestamp: DateTime<Utc>,
    /// Content at the parent commit (`None` = file created at this commit).
    pub parent_content: Option<String>,
    /// Content at this commit (`None` = file deleted at this commit).
    pub current_content: Option<String>,
}

/// Get the content of a file at a specific commit.
///
/// Returns `None` if the file did not exist at that commit.
pub fn get_file_at_commit(
    vault_dir: &Path,
    oid_str: &str,
    rel_path: &str,
) -> Result<Option<String>, GitError> {
    let repo = git2::Repository::open(vault_dir)?;
    let oid = git2::Oid::from_str(oid_str)
        .map_err(|e| GitError::Other(format!("invalid OID '{oid_str}': {e}")))?;
    let commit = repo.find_commit(oid)?;
    let tree = commit.tree()?;

    match tree.get_path(Path::new(rel_path)) {
        Ok(entry) => {
            let blob = repo.find_blob(entry.id())?;
            let content = std::str::from_utf8(blob.content()).map_err(|e| {
                GitError::Other(format!("UTF-8 decode failed for '{rel_path}': {e}"))
            })?;
            Ok(Some(content.to_string()))
        }
        Err(_) => Ok(None),
    }
}

/// Get the diff of a file between a commit and its parent.
pub fn get_commit_diff(
    vault_dir: &Path,
    oid_str: &str,
    rel_path: &str,
) -> Result<CommitDiff, GitError> {
    let repo = git2::Repository::open(vault_dir)?;
    let oid = git2::Oid::from_str(oid_str)
        .map_err(|e| GitError::Other(format!("invalid OID '{oid_str}': {e}")))?;
    let commit = repo.find_commit(oid)?;

    let timestamp = DateTime::from_timestamp(commit.time().seconds(), 0).unwrap_or_else(Utc::now);
    let message = commit.message().unwrap_or("").to_string();

    // Get content at this commit
    let tree = commit.tree()?;
    let current_content = match tree.get_path(Path::new(rel_path)) {
        Ok(entry) => {
            let blob = repo.find_blob(entry.id())?;
            Some(
                std::str::from_utf8(blob.content())
                    .map_err(|e| GitError::Other(format!("UTF-8 decode: {e}")))?
                    .to_string(),
            )
        }
        Err(_) => None,
    };

    // Get content at parent commit (if any)
    let parent_content = if commit.parent_count() > 0 {
        let parent = commit.parent(0)?;
        let parent_tree = parent.tree()?;
        match parent_tree.get_path(Path::new(rel_path)) {
            Ok(entry) => {
                let blob = repo.find_blob(entry.id())?;
                Some(
                    std::str::from_utf8(blob.content())
                        .map_err(|e| GitError::Other(format!("UTF-8 decode: {e}")))?
                        .to_string(),
                )
            }
            Err(_) => None,
        }
    } else {
        None
    };

    Ok(CommitDiff {
        oid: oid_str.to_string(),
        message,
        timestamp,
        parent_content,
        current_content,
    })
}

/// Restore a file to its state at a given commit.
///
/// Reads the file content from the target commit and writes it to the
/// working directory, then creates a **new** commit recording the restore.
/// Returns the new commit OID.
pub fn restore_file_to_commit(
    vault_dir: &Path,
    oid_str: &str,
    rel_path: &str,
) -> Result<String, GitError> {
    let content = get_file_at_commit(vault_dir, oid_str, rel_path)?.ok_or_else(|| {
        GitError::Other(format!("file '{rel_path}' not found at commit {oid_str}"))
    })?;

    // Write the old content to the working directory
    let abs_path = vault_dir.join(rel_path);
    std::fs::write(&abs_path, &content)
        .map_err(|e| GitError::Other(format!("failed to write '{rel_path}': {e}")))?;

    // Commit with a descriptive message
    let short_oid = &oid_str[..8.min(oid_str.len())];
    let now = Utc::now();
    let timestamp = now.format("%Y-%m-%d %H:%M:%S");
    let title = rel_path
        .rsplit('/')
        .next()
        .unwrap_or(rel_path)
        .trim_end_matches(".md");
    let message = format!("Restore: {title} \u{2014} to {short_oid} \u{2014} {timestamp}");

    let repo = git2::Repository::open(vault_dir)?;
    let mut index = repo.index()?;
    index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)?;
    index.update_all(["*"].iter(), None)?;
    unstage_device_local(&mut index);
    index.write()?;

    let tree_oid = index.write_tree()?;
    let tree = repo.find_tree(tree_oid)?;
    let sig = git2::Signature::now("Claspt", "claspt@localhost")?;

    let parent = repo.head()?.peel_to_commit()?;
    let oid = repo.commit(Some("HEAD"), &sig, &sig, &message, &tree, &[&parent])?;

    Ok(oid.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use tempfile::tempdir;

    fn setup_vault() -> (tempfile::TempDir, PathBuf) {
        let dir = tempdir().unwrap();
        let vault = dir.path().to_path_buf();

        // Initialize a git repo similar to vault init
        let repo = git2::Repository::init(&vault).unwrap();
        std::fs::create_dir_all(vault.join("general")).unwrap();
        std::fs::write(vault.join(".gitignore"), "*.tmp\n").unwrap();

        let mut index = repo.index().unwrap();
        index
            .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
            .unwrap();
        index.write().unwrap();
        let tree_oid = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        let sig = git2::Signature::now("Claspt", "claspt@localhost").unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "Initial vault setup", &tree, &[])
            .unwrap();

        (dir, vault)
    }

    #[test]
    fn commit_and_log() {
        let (_dir, vault) = setup_vault();

        // Create a file and commit
        std::fs::write(vault.join("general/note.md"), "# Hello\n").unwrap();
        let oid = commit_changes(&vault, "My Note").unwrap();
        assert!(oid.is_some());

        // Check log
        let log = get_log(&vault, 10).unwrap();
        assert_eq!(log.len(), 2); // initial + our commit
        assert!(log[0].message.starts_with("Update: My Note"));
        assert_eq!(log[1].message, "Initial vault setup");
    }

    #[test]
    fn commit_message_format() {
        let (_dir, vault) = setup_vault();

        std::fs::write(vault.join("general/note.md"), "content").unwrap();
        commit_changes(&vault, "Test Page").unwrap();

        let log = get_log(&vault, 1).unwrap();
        let msg = &log[0].message;
        // Should match: "Update: Test Page — YYYY-MM-DD HH:MM:SS"
        assert!(msg.starts_with("Update: Test Page \u{2014} "));
    }

    #[test]
    fn no_changes_returns_none() {
        let (_dir, vault) = setup_vault();

        // No changes to commit
        let oid = commit_changes(&vault, "Nothing").unwrap();
        assert!(oid.is_none());
    }

    #[test]
    fn file_log_tracks_changes() {
        let (_dir, vault) = setup_vault();

        let file_path = vault.join("general/tracked.md");

        // Create file
        std::fs::write(&file_path, "v1").unwrap();
        commit_changes(&vault, "Create").unwrap();

        // Update file
        std::fs::write(&file_path, "v2").unwrap();
        commit_changes(&vault, "Update").unwrap();

        // Create unrelated file
        std::fs::write(vault.join("general/other.md"), "other").unwrap();
        commit_changes(&vault, "Other").unwrap();

        let log = get_file_log(&vault, "general/tracked.md", 10).unwrap();
        // Should have 2 entries (create + update), not the "Other" commit
        assert_eq!(log.len(), 2);
    }

    #[test]
    fn multiple_commits_in_sequence() {
        let (_dir, vault) = setup_vault();

        std::fs::write(vault.join("general/a.md"), "a").unwrap();
        commit_changes(&vault, "Page A").unwrap();

        std::fs::write(vault.join("general/b.md"), "b").unwrap();
        commit_changes(&vault, "Page B").unwrap();

        std::fs::write(vault.join("general/a.md"), "a updated").unwrap();
        commit_changes(&vault, "Page A").unwrap();

        let log = get_log(&vault, 10).unwrap();
        assert_eq!(log.len(), 4); // initial + 3 commits
    }

    #[test]
    fn get_file_at_commit_returns_content() {
        let (_dir, vault) = setup_vault();

        std::fs::write(vault.join("general/note.md"), "version one").unwrap();
        let oid = commit_changes(&vault, "v1").unwrap().unwrap();

        let content = get_file_at_commit(&vault, &oid, "general/note.md").unwrap();
        assert_eq!(content.as_deref(), Some("version one"));
    }

    #[test]
    fn get_file_at_commit_nonexistent_returns_none() {
        let (_dir, vault) = setup_vault();
        let log = get_log(&vault, 1).unwrap();
        let oid = &log[0].oid;

        let content = get_file_at_commit(&vault, oid, "general/does-not-exist.md").unwrap();
        assert!(content.is_none());
    }

    #[test]
    fn get_commit_diff_shows_creation() {
        let (_dir, vault) = setup_vault();

        std::fs::write(vault.join("general/new.md"), "brand new").unwrap();
        let oid = commit_changes(&vault, "Create new").unwrap().unwrap();

        let diff = get_commit_diff(&vault, &oid, "general/new.md").unwrap();
        assert!(diff.parent_content.is_none()); // didn't exist before
        assert_eq!(diff.current_content.as_deref(), Some("brand new"));
        assert!(diff.message.contains("Create new"));
    }

    #[test]
    fn get_commit_diff_shows_edit() {
        let (_dir, vault) = setup_vault();

        std::fs::write(vault.join("general/note.md"), "v1").unwrap();
        commit_changes(&vault, "v1").unwrap();

        std::fs::write(vault.join("general/note.md"), "v2").unwrap();
        let oid = commit_changes(&vault, "v2").unwrap().unwrap();

        let diff = get_commit_diff(&vault, &oid, "general/note.md").unwrap();
        assert_eq!(diff.parent_content.as_deref(), Some("v1"));
        assert_eq!(diff.current_content.as_deref(), Some("v2"));
    }

    #[test]
    fn get_file_at_commit_invalid_oid_returns_error() {
        let (_dir, vault) = setup_vault();

        let result = get_file_at_commit(&vault, "not-a-valid-oid", "general/note.md");
        assert!(result.is_err());
    }

    #[test]
    fn restore_file_to_commit_creates_new_commit() {
        let (_dir, vault) = setup_vault();

        // v1
        std::fs::write(vault.join("general/note.md"), "version one").unwrap();
        let v1_oid = commit_changes(&vault, "v1").unwrap().unwrap();

        // v2
        std::fs::write(vault.join("general/note.md"), "version two").unwrap();
        commit_changes(&vault, "v2").unwrap();

        // Verify current content is v2
        let current = std::fs::read_to_string(vault.join("general/note.md")).unwrap();
        assert_eq!(current, "version two");

        // Restore to v1
        let restore_oid = restore_file_to_commit(&vault, &v1_oid, "general/note.md").unwrap();
        assert!(!restore_oid.is_empty());

        // File should now be v1
        let restored = std::fs::read_to_string(vault.join("general/note.md")).unwrap();
        assert_eq!(restored, "version one");

        // Should have a new commit with "Restore:" message
        let log = get_log(&vault, 5).unwrap();
        assert!(log[0].message.starts_with("Restore:"));
        // Total commits: initial + v1 + v2 + restore = 4
        assert_eq!(log.len(), 4);
    }
}
