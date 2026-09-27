// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Remove a value that has just become a secret from the recent versions of
//! its page.
//!
//! The at-rest rule keeps recognisable credentials out of history. A value the
//! recogniser did not recognise, converted by hand, may already sit in the
//! last few versions of the page: one per pause while it was pasted. This
//! rewrites exactly that run, the contiguous tail of versions holding the
//! value, and the versions above it, which only need a new parent. Everything
//! older keeps its objects and ids, byte for byte.
//!
//! It refuses rather than guesses. A value in a version older than a day, in
//! more than thirty versions, in a version beyond a gap, or beyond a merge is
//! left where it is and the outcome says so; the owner can reset history
//! instead. The pages on disk are never written to. Nothing here logs a value.

use std::collections::HashSet;
use std::path::Path;

use git2::{Oid, Repository};
use serde::Serialize;

use super::error::GitError;

/// The longest run of versions that is rewritten automatically.
pub const MAX_TAIL_COMMITS: usize = 30;
/// The oldest a version in the run may be.
pub const MAX_TAIL_AGE_SECS: i64 = 86_400;
/// Values shorter than this are not scrubbed: they are too likely to be
/// ordinary words or numbers that appear elsewhere in the page's past.
pub const MIN_VALUE_LEN: usize = 8;
/// What stands where the value stood in the rewritten versions.
pub const REDACTION: &str = "[moved into a secret]";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ScrubOutcome {
    /// No recent version holds the value.
    Clean,
    /// The run was rewritten. `remaining_objects` counts old objects that
    /// live in a pack and could not be removed one by one; a reset removes
    /// them.
    Rewrote {
        commits: usize,
        remaining_objects: usize,
    },
    /// Nothing was changed, for the reason given.
    LeftInHistory { reason: String },
}

/// The text of `rel_path` at `commit`, when it exists and is text.
fn text_at(repo: &Repository, commit: &git2::Commit<'_>, rel_path: &Path) -> Option<String> {
    let entry = commit.tree().ok()?.get_path(rel_path).ok()?;
    let blob = repo.find_blob(entry.id()).ok()?;
    String::from_utf8(blob.content().to_vec()).ok()
}

fn holds(text: Option<&str>, values: &[String]) -> bool {
    text.is_some_and(|t| values.iter().any(|v| t.contains(v.as_str())))
}

/// A copy of `tree` with the blob at `components` replaced by `blob`, the
/// file mode kept, and the ids of every tree replaced on the way collected
/// in `replaced`.
fn tree_with_blob(
    repo: &Repository,
    tree: &git2::Tree<'_>,
    components: &[&str],
    blob: Oid,
    replaced: &mut Vec<Oid>,
) -> Result<Oid, GitError> {
    let (name, rest) = components
        .split_first()
        .ok_or_else(|| GitError::Other("empty path".into()))?;
    let entry = tree
        .get_name(name)
        .ok_or_else(|| GitError::Other(format!("{name} is not in the tree")))?;
    let mut builder = repo.treebuilder(Some(tree))?;
    if rest.is_empty() {
        builder.insert(name, blob, entry.filemode())?;
    } else {
        let subtree = repo.find_tree(entry.id())?;
        let new_subtree = tree_with_blob(repo, &subtree, rest, blob, replaced)?;
        builder.insert(name, new_subtree, entry.filemode())?;
    }
    replaced.push(tree.id());
    Ok(builder.write()?)
}

/// Every commit, tree and blob reachable from `head`.
fn reachable(repo: &Repository, head: Oid) -> Result<HashSet<Oid>, GitError> {
    let mut set = HashSet::new();
    let mut walk = repo.revwalk()?;
    walk.push(head)?;
    for oid in walk {
        let oid = oid?;
        set.insert(oid);
        let tree = repo.find_commit(oid)?.tree()?;
        set.insert(tree.id());
        tree.walk(git2::TreeWalkMode::PreOrder, |_, entry| {
            set.insert(entry.id());
            git2::TreeWalkResult::Ok
        })?;
    }
    Ok(set)
}

/// Remove a loose object's file. An object in a pack cannot be removed alone;
/// `false` says it is still there.
fn remove_loose_object(repo: &Repository, oid: Oid) -> bool {
    let hex = oid.to_string();
    let path = repo.path().join("objects").join(&hex[..2]).join(&hex[2..]);
    path.exists() && std::fs::remove_file(&path).is_ok()
}

/// Rewrite the recent versions of `rel_path` that hold any of `values`.
/// Callers hold the batch committer's history lock.
pub fn scrub_tail(
    vault_dir: &Path,
    rel_path: &str,
    values: &[String],
) -> Result<ScrubOutcome, GitError> {
    let values: Vec<String> = values
        .iter()
        .filter(|v| v.chars().count() >= MIN_VALUE_LEN)
        .cloned()
        .collect();
    if values.is_empty() {
        return Ok(ScrubOutcome::Clean);
    }
    let repo = Repository::open(vault_dir)?;
    let head_ref = repo.head()?;
    let branch = match head_ref.name() {
        Ok(name) if name.starts_with("refs/heads/") => name.to_string(),
        _ => {
            return Ok(ScrubOutcome::LeftInHistory {
                reason: "the vault's history is not on a branch".into(),
            })
        }
    };
    let head = head_ref.peel_to_commit()?;
    let path = Path::new(rel_path);
    let now = chrono::Utc::now().timestamp();

    // Newest first: the versions above the run, then the run itself.
    let mut above: Vec<git2::Commit<'_>> = Vec::new();
    let mut affected: Vec<git2::Commit<'_>> = Vec::new();
    let mut cursor = Some(head.clone());
    let mut run_ended = false;
    while let Some(commit) = cursor {
        if commit.parent_count() > 1 && !run_ended {
            return Ok(ScrubOutcome::LeftInHistory {
                reason: "a merged version is in the way".into(),
            });
        }
        let text = text_at(&repo, &commit, path);
        let here = holds(text.as_deref(), &values);
        if run_ended {
            if here {
                return Ok(ScrubOutcome::LeftInHistory {
                    reason: "the value is also in an older version, beyond the recent run".into(),
                });
            }
        } else if here {
            if now - commit.time().seconds() > MAX_TAIL_AGE_SECS {
                return Ok(ScrubOutcome::LeftInHistory {
                    reason: "the value is in a version older than a day".into(),
                });
            }
            affected.push(commit.clone());
        } else if affected.is_empty() {
            above.push(commit.clone());
        } else {
            run_ended = true;
        }
        if !run_ended && above.len() + affected.len() > MAX_TAIL_COMMITS {
            return Ok(ScrubOutcome::LeftInHistory {
                reason: format!("the value is in more than {MAX_TAIL_COMMITS} recent versions"),
            });
        }
        cursor = commit.parent(0).ok();
    }
    if affected.is_empty() {
        return Ok(ScrubOutcome::Clean);
    }

    // Rebuild from the oldest affected version up to the head.
    let components: Vec<&str> = rel_path.split('/').filter(|c| !c.is_empty()).collect();
    let mut old_ids: Vec<Oid> = Vec::new();
    let mut replaced_trees: Vec<Oid> = Vec::new();
    let mut old_blobs: Vec<Oid> = Vec::new();
    let mut parent: Option<Oid> = affected
        .last()
        .and_then(|c| c.parent(0).ok())
        .map(|p| p.id());
    let base = parent;
    let mut new_head: Option<Oid> = None;
    let mut rewritten = 0usize;
    let affected_ids: HashSet<Oid> = affected.iter().map(|c| c.id()).collect();
    for old in affected.iter().rev().chain(above.iter().rev()) {
        let old_tree = old.tree()?;
        let tree_id = if affected_ids.contains(&old.id()) {
            let text = text_at(&repo, old, path).unwrap_or_default();
            let mut redacted = text;
            for v in &values {
                redacted = redacted.replace(v.as_str(), REDACTION);
            }
            if let Ok(entry) = old_tree.get_path(path) {
                old_blobs.push(entry.id());
            }
            let blob = repo.blob(redacted.as_bytes())?;
            tree_with_blob(&repo, &old_tree, &components, blob, &mut replaced_trees)?
        } else {
            old_tree.id()
        };
        let tree = repo.find_tree(tree_id)?;
        let parents: Vec<git2::Commit<'_>> = match parent {
            Some(p) => vec![repo.find_commit(p)?],
            None => vec![],
        };
        let parent_refs: Vec<&git2::Commit<'_>> = parents.iter().collect();
        let id = repo.commit(
            None,
            &old.author(),
            &old.committer(),
            old.message().unwrap_or(""),
            &tree,
            &parent_refs,
        )?;
        old_ids.push(old.id());
        parent = Some(id);
        new_head = Some(id);
        rewritten += 1;
    }
    let new_head = new_head.ok_or_else(|| GitError::Other("nothing was rewritten".into()))?;

    // Prove the result before it becomes the branch.
    let mut check = Some(repo.find_commit(new_head)?);
    let mut checked = 0usize;
    while let Some(commit) = check {
        if Some(commit.id()) == base || (base.is_none() && checked == rewritten) {
            break;
        }
        if holds(text_at(&repo, &commit, path).as_deref(), &values) {
            return Err(GitError::Other(
                "the rewritten history still holds the value; nothing was changed".into(),
            ));
        }
        checked += 1;
        check = commit.parent(0).ok();
    }
    if checked != rewritten {
        return Err(GitError::Other(
            "the rewritten history has the wrong length; nothing was changed".into(),
        ));
    }
    let head_text_before = text_at(&repo, &head, path).unwrap_or_default();
    let mut expected_head = head_text_before;
    for v in &values {
        expected_head = expected_head.replace(v.as_str(), REDACTION);
    }
    let head_text_after = text_at(&repo, &repo.find_commit(new_head)?, path).unwrap_or_default();
    if head_text_after != expected_head {
        return Err(GitError::Other(
            "the newest rewritten version does not match; nothing was changed".into(),
        ));
    }

    // One atomic step makes it real; then the record of the old ids goes.
    repo.find_reference(&branch)?
        .set_target(new_head, "history scrub")?;
    let _ = repo.reflog_delete(&branch);
    let _ = repo.reflog_delete("HEAD");

    // Old objects that nothing references any more are removed one by one.
    let keep = reachable(&repo, new_head)?;
    let mut remaining_objects = 0usize;
    for oid in old_ids
        .iter()
        .chain(replaced_trees.iter())
        .chain(old_blobs.iter())
    {
        if keep.contains(oid) {
            continue;
        }
        if !remove_loose_object(&repo, *oid) {
            remaining_objects += 1;
        }
    }
    Ok(ScrubOutcome::Rewrote {
        commits: rewritten,
        remaining_objects,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::ops;
    use std::path::PathBuf;

    const VALUE: &str = "hunter2-hunter2-hunter2";

    fn setup_vault() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path().to_path_buf();
        let repo = Repository::init(&vault).unwrap();
        std::fs::create_dir_all(vault.join("general")).unwrap();
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

    fn write_and_commit(vault: &Path, text: &str, title: &str) -> String {
        std::fs::write(vault.join("general/a.md"), text).unwrap();
        ops::commit_changes(vault, title).unwrap().unwrap()
    }

    fn head_id(vault: &Path) -> Oid {
        Repository::open(vault)
            .unwrap()
            .head()
            .unwrap()
            .target()
            .unwrap()
    }

    #[test]
    fn scrub_rewrites_the_tail_and_keeps_everything_else() {
        let (_d, vault) = setup_vault();
        let c1 = head_id(&vault);
        let c2 = write_and_commit(&vault, &format!("Notes\npassword: {VALUE}\n"), "a");
        let c3 = write_and_commit(&vault, &format!("Notes\npassword: {VALUE}\nMore\n"), "a");
        let sealed = "Notes\n:::secret[Login]\npassword: enc:v1:AAAA\n:::\nMore\n";
        let c4 = write_and_commit(&vault, sealed, "a");

        let outcome = scrub_tail(&vault, "general/a.md", &[VALUE.to_string()]).unwrap();
        assert_eq!(
            outcome,
            ScrubOutcome::Rewrote {
                commits: 3,
                remaining_objects: 0
            }
        );

        // The page on disk is untouched.
        assert_eq!(
            std::fs::read_to_string(vault.join("general/a.md")).unwrap(),
            sealed
        );
        let repo = Repository::open(&vault).unwrap();
        // The old versions are gone, the oldest untouched version is not.
        for old in [c2, c3, c4] {
            assert!(repo.find_commit(Oid::from_str(&old).unwrap()).is_err());
        }
        assert!(repo.find_commit(c1).is_ok());
        // The chain below the rewritten run is the old one: three parents up is c1.
        let mut cursor = repo.head().unwrap().peel_to_commit().unwrap();
        for _ in 0..3 {
            cursor = cursor.parent(0).unwrap();
        }
        assert_eq!(cursor.id(), c1);
        // Still four versions with their messages, none holding the value, and
        // the redaction standing where it stood. (Commit times share a second
        // here, so the log's order is not asserted.)
        let log = ops::get_file_log(&vault, "general/a.md", 10).unwrap();
        assert_eq!(log.len(), 4);
        assert_eq!(
            log.iter()
                .filter(|e| e.message.starts_with("Update: a"))
                .count(),
            3
        );
        let texts: Vec<String> = log
            .iter()
            .map(|e| {
                ops::get_file_at_commit(&vault, &e.oid, "general/a.md")
                    .unwrap()
                    .unwrap()
            })
            .collect();
        assert!(texts.iter().all(|t| !t.contains(VALUE)));
        assert!(texts.contains(&format!("Notes\npassword: {REDACTION}\n")));
        // The newest version still describes the disk.
        assert!(ops::commit_changes(&vault, "check").unwrap().is_none());
    }

    #[test]
    fn scrub_refuses_when_the_value_is_older_than_the_tail() {
        let (_d, vault) = setup_vault();
        write_and_commit(&vault, &format!("password: {VALUE}\n"), "a");
        write_and_commit(&vault, "clean\n", "a");
        write_and_commit(&vault, &format!("again: {VALUE}\n"), "a");
        let before = head_id(&vault);
        let outcome = scrub_tail(&vault, "general/a.md", &[VALUE.to_string()]).unwrap();
        assert!(
            matches!(outcome, ScrubOutcome::LeftInHistory { .. }),
            "{outcome:?}"
        );
        assert_eq!(head_id(&vault), before);
    }

    #[test]
    fn scrub_refuses_a_run_over_the_cap() {
        let (_d, vault) = setup_vault();
        for i in 0..=MAX_TAIL_COMMITS {
            write_and_commit(&vault, &format!("v{i}\npassword: {VALUE}\n"), "a");
        }
        let before = head_id(&vault);
        let outcome = scrub_tail(&vault, "general/a.md", &[VALUE.to_string()]).unwrap();
        assert!(
            matches!(outcome, ScrubOutcome::LeftInHistory { .. }),
            "{outcome:?}"
        );
        assert_eq!(head_id(&vault), before);
    }

    #[test]
    fn scrub_reports_clean_when_nothing_holds_the_value_or_the_value_is_short() {
        let (_d, vault) = setup_vault();
        write_and_commit(&vault, "nothing here\n", "a");
        assert_eq!(
            scrub_tail(&vault, "general/a.md", &[VALUE.to_string()]).unwrap(),
            ScrubOutcome::Clean
        );
        write_and_commit(&vault, "pin: 1234\n", "a");
        assert_eq!(
            scrub_tail(&vault, "general/a.md", &["1234".to_string()]).unwrap(),
            ScrubOutcome::Clean
        );
    }
}
