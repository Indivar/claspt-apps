// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Git operations over the vault repo: auto-commit, whole-vault and per-file
//! commit logs, per-commit file content and diffs, and file restore. All
//! `git2`-backed and keyed on 40-char hex OIDs. Key invariant: writes only ever
//! move history forward — commits are authored as `Claspt <claspt@localhost>`
//! and a restore writes the old content back as a fresh commit, never a rewrite.
use std::path::Path;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::error::GitError;

/// A commit entry for version history display.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitEntry {
    /// Commit OID as a 40-char hex string.
    pub oid: String,
    /// Full commit message.
    pub message: String,
    /// Commit time (UTC).
    pub timestamp: DateTime<Utc>,
}

/// Stage every change in the working tree, skipping nested git repositories.
///
/// A vault is an ordinary folder, so anything can end up inside one, including
/// a checked-out repository. libgit2 will not add such a path to the index
/// (it would have to become a submodule) and fails the entire staging call
/// with `invalid path: '<dir>/'`. Left unhandled that ends version history
/// from the moment the nested repository appears, and it aborts vault
/// creation outright when the chosen folder already contains one.
///
/// Skipping those paths keeps every other change committable. The nested
/// repository is left alone rather than absorbed, which is what the user
/// meant by putting it there.
pub fn stage_all(repo: &git2::Repository, index: &mut git2::Index) -> Result<(), git2::Error> {
    let workdir = repo.workdir().map(Path::to_path_buf);
    let mut skip_nested = |path: &Path, _matched: &[u8]| -> i32 {
        match &workdir {
            // Non-zero skips the path; zero adds it.
            Some(root) if is_nested_repository(&root.join(path)) => 1,
            _ => 0,
        }
    };
    index.add_all(
        ["*"].iter(),
        git2::IndexAddOption::DEFAULT,
        Some(&mut skip_nested),
    )
}

/// Whether `path` is a directory holding its own git repository.
fn is_nested_repository(path: &Path) -> bool {
    path.is_dir() && path.join(".git").exists()
}

/// Commit all changes in the vault repository.
///
/// Stages all modified/added/deleted files and creates a commit
/// with the format: "Update: {title} — {timestamp}"
pub fn commit_changes(vault_dir: &Path, title: &str) -> Result<Option<String>, GitError> {
    let repo = git2::Repository::open(vault_dir)?;

    // Stage all changes
    let mut index = repo.index()?;
    stage_all(&repo, &mut index)?;
    // Also stage deletions
    index.update_all(["*"].iter(), None)?;
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
    /// Commit OID as a 40-char hex string.
    pub oid: String,
    /// Full commit message.
    pub message: String,
    /// Commit time (UTC).
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
    stage_all(&repo, &mut index)?;
    index.update_all(["*"].iter(), None)?;
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

    #[test]
    fn a_nested_repository_inside_the_vault_does_not_stop_commits() {
        // A vault is an ordinary folder, so a user can put a checked-out
        // repository inside one. libgit2 refuses to add such a path to the
        // index, and before this was handled it failed the whole staging call
        // with `invalid path: '<dir>/'`, which silently ended version history
        // from that moment on.
        let tmp = tempfile::TempDir::new().unwrap();
        let vault = tmp.path();
        git2::Repository::init(vault).unwrap();
        std::fs::create_dir_all(vault.join("general")).unwrap();
        std::fs::write(vault.join("general/note.md"), "hello").unwrap();

        let nested = vault.join("someone-elses-project");
        std::fs::create_dir_all(&nested).unwrap();
        git2::Repository::init(&nested).unwrap();
        std::fs::write(nested.join("README.md"), "not ours").unwrap();

        let oid = commit_changes(vault, "note").expect("a nested repo must not fail the commit");
        assert!(oid.is_some(), "the note should have been committed");

        // The note is in the commit; the nested repository is not.
        let repo = git2::Repository::open(vault).unwrap();
        let tree = repo
            .head()
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .tree()
            .unwrap();
        assert!(tree.get_path(Path::new("general/note.md")).is_ok());
        assert!(
            tree.get_path(Path::new("someone-elses-project")).is_err(),
            "the nested repository must not be swallowed into the vault history"
        );
    }
}
