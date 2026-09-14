// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Debounced batch-commit scheduler.
//!
//! Auto-committing on every keystroke-driven save would flood the git history. Instead
//! saves are coalesced: [`BatchCommitter::record_save`] defers a commit while edits keep
//! arriving within a 5-second window (see [`BATCH_WINDOW`]) and only writes one commit,
//! using the most recent page title. A background "git-batch-flush" thread wakes every
//! [`IDLE_FLUSH_TICK`] to flush a pending commit once the window has elapsed with no
//! further activity, so a lone edit doesn't stay uncommitted forever. [`BatchCommitter::flush`]
//! and [`BatchCommitter::clear`] force an immediate commit on explicit save, app close, or
//! vault lock.
//!
//! All git I/O is performed *outside* the state mutex — commit details are copied out under
//! the lock, then the lock is released before touching the repository.
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::error::GitError;
use super::ops;

/// Batch commit window duration.
const BATCH_WINDOW: Duration = Duration::from_secs(5);

/// How often the idle-flush thread wakes to check for pending commits.
const IDLE_FLUSH_TICK: Duration = Duration::from_millis(500);

/// Tracks pending changes for batch commits.
///
/// Multiple saves within 5 seconds are combined into a single commit.
/// The commit uses the title of the most recent save. A background timer
/// flushes pending commits once the batch window has elapsed with no further
/// activity — without it, a single edit would stay pending forever (git HEAD
/// wouldn't advance, and auto-sync would have nothing to push).
pub struct BatchCommitter {
    state: Arc<Mutex<BatchState>>,
    stop: Arc<AtomicBool>,
}

struct BatchState {
    vault_dir: Option<PathBuf>,
    last_title: Option<String>,
    last_save: Option<Instant>,
    pending: bool,
}

impl Drop for BatchCommitter {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

impl BatchCommitter {
    /// Create a committer with empty state and spawn its background idle-flush thread.
    /// The thread stops when this `BatchCommitter` is dropped (see the [`Drop`] impl).
    pub fn new() -> Self {
        let state = Arc::new(Mutex::new(BatchState {
            vault_dir: None,
            last_title: None,
            last_save: None,
            pending: false,
        }));
        let stop = Arc::new(AtomicBool::new(false));

        let timer_state = Arc::clone(&state);
        let timer_stop = Arc::clone(&stop);
        let _ = std::thread::Builder::new()
            .name("git-batch-flush".into())
            .spawn(move || {
                while !timer_stop.load(Ordering::Relaxed) {
                    std::thread::sleep(IDLE_FLUSH_TICK);
                    // Extract commit info under the lock, then do git I/O outside
                    let commit_info = {
                        let Ok(mut s) = timer_state.lock() else {
                            continue;
                        };
                        if !s.pending {
                            continue;
                        }
                        let Some(last) = s.last_save else { continue };
                        if last.elapsed() < BATCH_WINDOW {
                            continue;
                        }
                        let Some(vd) = s.vault_dir.clone() else {
                            continue;
                        };
                        let title = s
                            .last_title
                            .clone()
                            .unwrap_or_else(|| "Untitled".to_string());
                        s.pending = false;
                        Some((vd, title))
                    };
                    if let Some((vd, title)) = commit_info {
                        if let Err(e) = ops::commit_changes(&vd, &title) {
                            log::warn!("[git-batch] idle flush failed: {e}");
                        }
                    }
                }
            });

        Self { state, stop }
    }

    /// Set the vault directory (called on vault unlock).
    pub fn set_vault_dir(&self, vault_dir: &Path) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        state.vault_dir = Some(vault_dir.to_path_buf());
    }

    /// Clear state (called on vault lock).
    pub fn clear(&self) {
        // Extract commit info while holding the lock, then release before I/O
        let commit_info = {
            let Ok(mut state) = self.state.lock() else {
                return;
            };
            if state.pending {
                let info = state.vault_dir.clone().zip(state.last_title.clone());
                state.vault_dir = None;
                state.last_title = None;
                state.last_save = None;
                state.pending = false;
                info
            } else {
                state.vault_dir = None;
                state.last_title = None;
                state.last_save = None;
                state.pending = false;
                None
            }
        };
        // Perform git I/O outside the lock
        if let Some((vault_dir, title)) = commit_info {
            let _ = ops::commit_changes(&vault_dir, &title);
        }
    }

    /// Record a save. If the previous save was within the batch window,
    /// the commit is deferred. Otherwise, the previous pending commit is
    /// flushed and a new batch window starts.
    ///
    /// Returns the commit OID if a commit was flushed.
    pub fn record_save(&self, title: &str) -> Result<Option<String>, GitError> {
        // Extract commit info while holding the lock, then release before I/O
        let commit_info = {
            let mut state = self.state.lock().map_err(|_| GitError::LockPoisoned)?;
            let now = Instant::now();

            let needs_flush = if let Some(last) = state.last_save {
                now.duration_since(last) > BATCH_WINDOW && state.pending
            } else {
                false
            };

            let info = if needs_flush {
                Some((
                    state.vault_dir.clone().ok_or(GitError::VaultNotOpen)?,
                    state
                        .last_title
                        .clone()
                        .unwrap_or_else(|| "Untitled".to_string()),
                ))
            } else {
                None
            };

            // Start/continue the batch
            state.last_title = Some(title.to_string());
            state.last_save = Some(now);
            state.pending = true;

            info
        }; // lock released here

        // Perform git I/O outside the lock
        let flushed_oid = if let Some((vault_dir, last_title)) = commit_info {
            ops::commit_changes(&vault_dir, &last_title)?
        } else {
            None
        };

        Ok(flushed_oid)
    }

    /// Force-flush any pending commit (e.g., on app close or explicit save).
    pub fn flush(&self) -> Result<Option<String>, GitError> {
        // Extract commit info while holding the lock, then release before I/O
        let commit_info = {
            let mut state = self.state.lock().map_err(|_| GitError::LockPoisoned)?;
            if !state.pending {
                return Ok(None);
            }
            let info = (
                state.vault_dir.clone().ok_or(GitError::VaultNotOpen)?,
                state
                    .last_title
                    .clone()
                    .unwrap_or_else(|| "Untitled".to_string()),
            );
            state.pending = false;
            state.last_save = None;
            info
        }; // lock released here

        let (vault_dir, title) = commit_info;
        let oid = ops::commit_changes(&vault_dir, &title)?;
        Ok(oid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn setup_vault() -> (tempfile::TempDir, PathBuf) {
        let dir = tempdir().unwrap();
        let vault = dir.path().to_path_buf();

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
    fn flush_commits_pending_changes() {
        let (_dir, vault) = setup_vault();
        let batcher = BatchCommitter::new();
        batcher.set_vault_dir(&vault);

        std::fs::write(vault.join("general/note.md"), "content").unwrap();
        batcher.record_save("My Note").unwrap();

        let oid = batcher.flush().unwrap();
        assert!(oid.is_some());

        let log = ops::get_log(&vault, 10).unwrap();
        assert_eq!(log.len(), 2);
        assert!(log[0].message.contains("My Note"));
    }

    #[test]
    fn rapid_saves_batched() {
        let (_dir, vault) = setup_vault();
        let batcher = BatchCommitter::new();
        batcher.set_vault_dir(&vault);

        // Rapid saves within batch window
        std::fs::write(vault.join("general/note.md"), "v1").unwrap();
        batcher.record_save("Note v1").unwrap();

        std::fs::write(vault.join("general/note.md"), "v2").unwrap();
        batcher.record_save("Note v2").unwrap();

        std::fs::write(vault.join("general/note.md"), "v3").unwrap();
        batcher.record_save("Note v3").unwrap();

        // Flush — should create one commit with the latest title
        let oid = batcher.flush().unwrap();
        assert!(oid.is_some());

        let log = ops::get_log(&vault, 10).unwrap();
        assert_eq!(log.len(), 2); // initial + 1 batched commit
        assert!(log[0].message.contains("Note v3"));
    }

    #[test]
    fn flush_with_nothing_pending() {
        let (_dir, vault) = setup_vault();
        let batcher = BatchCommitter::new();
        batcher.set_vault_dir(&vault);

        let oid = batcher.flush().unwrap();
        assert!(oid.is_none());
    }

    #[test]
    fn clear_flushes_pending() {
        let (_dir, vault) = setup_vault();
        let batcher = BatchCommitter::new();
        batcher.set_vault_dir(&vault);

        std::fs::write(vault.join("general/note.md"), "content").unwrap();
        batcher.record_save("Final Note").unwrap();

        batcher.clear();

        // The clear should have flushed
        let log = ops::get_log(&vault, 10).unwrap();
        assert_eq!(log.len(), 2);
    }
}
