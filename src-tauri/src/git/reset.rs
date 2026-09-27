// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Start version history afresh from the pages as they are now.
//!
//! Version history is a convenience layered on top of the vault: the pages,
//! the key and the config are files, and git holds copies of their past. When
//! that past holds something it should not, a credential that sat in a page
//! in plain text before it was made a secret, the simplest safe answer is a
//! new history with one version, the present. Nothing here writes to a page.
//!
//! The old history is moved aside, never edited in place: a fresh repository
//! is built, checked against the files on disk, and only then is the old one
//! removed. If anything fails before that point the old history goes back
//! exactly as it was. If the process dies between the two renames, the next
//! open finds `.git.old` and puts it back.

use std::path::Path;

use super::error::GitError;
use super::ops;

/// Where the old history waits while the new one is built and checked.
pub const OLD_HISTORY_DIR: &str = ".git.old";

/// Replace the vault's history with a single version of the pages on disk.
/// Returns the id of that version. Callers hold the batch committer's history
/// lock, so no commit runs while the repository is swapped.
pub fn reset_history(vault_dir: &Path) -> Result<String, GitError> {
    let git_dir = vault_dir.join(".git");
    let old_dir = vault_dir.join(OLD_HISTORY_DIR);
    if !git_dir.exists() {
        return Err(GitError::Other("no version history to reset".into()));
    }
    if old_dir.exists() {
        // Left by an earlier run that died after its swap; the live history is
        // `.git`, so this copy is surplus.
        std::fs::remove_dir_all(&old_dir).map_err(|e| GitError::Other(e.to_string()))?;
    }
    std::fs::rename(&git_dir, &old_dir).map_err(|e| GitError::Other(e.to_string()))?;

    match build_fresh_history(vault_dir) {
        Ok(oid) => {
            std::fs::remove_dir_all(&old_dir).map_err(|e| GitError::Other(e.to_string()))?;
            Ok(oid)
        }
        Err(e) => {
            // Whatever was built is discarded and the old history goes back.
            if git_dir.exists() {
                let _ = std::fs::remove_dir_all(&git_dir);
            }
            let _ = std::fs::rename(&old_dir, &git_dir);
            Err(e)
        }
    }
}

/// Build a new repository at `vault_dir` holding one commit of the working
/// tree, staged exactly as the auto-committer stages it, and prove that the
/// commit matches the files on disk.
fn build_fresh_history(vault_dir: &Path) -> Result<String, GitError> {
    let repo = git2::Repository::init(vault_dir)?;
    crate::vault::init::reconcile_gitignore(vault_dir)
        .map_err(|e| GitError::Other(e.to_string()))?;

    let mut index = repo.index()?;
    claspt_core::git::ops::stage_all(&repo, &mut index)?;
    ops::unstage_device_local(&mut index);
    index.write()?;
    let tree_oid = index.write_tree()?;
    let tree = repo.find_tree(tree_oid)?;
    let sig = git2::Signature::now("Claspt", "claspt@localhost")?;
    let oid = repo.commit(
        Some("HEAD"),
        &sig,
        &sig,
        "Version history reset",
        &tree,
        &[],
    )?;

    // Stage again from scratch and compare: the same rules must produce the
    // same tree, or the commit does not describe what is on disk.
    let mut check = repo.index()?;
    claspt_core::git::ops::stage_all(&repo, &mut check)?;
    check.update_all(["*"].iter(), None)?;
    ops::unstage_device_local(&mut check);
    if check.write_tree()? != tree_oid {
        return Err(GitError::ResetVerificationFailed);
    }
    Ok(oid.to_string())
}

/// A reset that died between its two renames leaves `.git.old` and no `.git`.
/// The old history is put back; nothing was lost.
pub fn recover_interrupted_reset(vault_dir: &Path) -> Result<(), GitError> {
    let git_dir = vault_dir.join(".git");
    let old_dir = vault_dir.join(OLD_HISTORY_DIR);
    if !git_dir.exists() && old_dir.exists() {
        std::fs::rename(&old_dir, &git_dir).map_err(|e| GitError::Other(e.to_string()))?;
        log::warn!("[git] an interrupted history reset was undone; the old history is in place");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn setup_vault() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path().to_path_buf();
        let repo = git2::Repository::init(&vault).unwrap();
        std::fs::create_dir_all(vault.join("general")).unwrap();
        std::fs::create_dir_all(vault.join(".securenotes")).unwrap();
        std::fs::write(vault.join("general/a.md"), "one\n").unwrap();
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
    fn reset_keeps_every_file_and_forgets_every_old_version() {
        let (_d, vault) = setup_vault();
        let old_head = git2::Repository::open(&vault)
            .unwrap()
            .head()
            .unwrap()
            .target()
            .unwrap();
        std::fs::write(vault.join("general/a.md"), "two\n").unwrap();
        ops::commit_changes(&vault, "a").unwrap();
        std::fs::write(vault.join("general/b.md"), "new page\n").unwrap();
        ops::commit_changes(&vault, "b").unwrap();
        assert_eq!(ops::get_log(&vault, 10).unwrap().len(), 3);

        let new_head = reset_history(&vault).unwrap();

        assert_eq!(
            std::fs::read_to_string(vault.join("general/a.md")).unwrap(),
            "two\n"
        );
        assert_eq!(
            std::fs::read_to_string(vault.join("general/b.md")).unwrap(),
            "new page\n"
        );
        let repo = git2::Repository::open(&vault).unwrap();
        let log = ops::get_log(&vault, 10).unwrap();
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].oid, new_head);
        assert!(repo.find_commit(old_head).is_err(), "old versions are gone");
        assert!(!vault.join(OLD_HISTORY_DIR).exists());
        // Nothing left to commit: the one version is the disk.
        assert!(ops::commit_changes(&vault, "check").unwrap().is_none());
    }

    #[test]
    fn recover_interrupted_reset_restores_the_old_history() {
        let (_d, vault) = setup_vault();
        std::fs::rename(vault.join(".git"), vault.join(OLD_HISTORY_DIR)).unwrap();
        recover_interrupted_reset(&vault).unwrap();
        assert!(vault.join(".git").exists());
        assert!(!vault.join(OLD_HISTORY_DIR).exists());
        assert_eq!(ops::get_log(&vault, 10).unwrap().len(), 1);
    }

    #[test]
    fn recover_leaves_a_healthy_vault_alone() {
        let (_d, vault) = setup_vault();
        recover_interrupted_reset(&vault).unwrap();
        assert_eq!(ops::get_log(&vault, 10).unwrap().len(), 1);
    }

    #[test]
    fn reset_without_a_history_is_refused_and_touches_nothing() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.md"), "x").unwrap();
        assert!(reset_history(dir.path()).is_err());
        assert_eq!(
            std::fs::read_to_string(dir.path().join("a.md")).unwrap(),
            "x"
        );
    }
}
