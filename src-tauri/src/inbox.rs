// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Inbox watcher — monitors `.inbox/` directory for new markdown files.
//!
//! When a `.md` file is dropped into `{vault_dir}/.inbox/`, the watcher:
//! 1. Reads the file (with optional YAML frontmatter for folder/tags)
//! 2. Creates a page via the CRUD module
//! 3. Encrypts any secret blocks
//! 4. Indexes the page for search
//! 5. Records a git save
//! 6. Deletes the inbox file
//!
//! A file whose secrets cannot be encrypted is never ingested and never
//! deleted — it is moved to `.inbox/failed/` instead. See
//! [`quarantine_inbox_file`].
//!
//! Started on vault unlock, stopped on lock.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::Emitter;
use zeroize::Zeroizing;

use crate::commands::git::GitState;
use crate::commands::search::{page_to_document, SearchState};
use crate::pages::{crud, secret};
use crate::search::engine::SearchEngine;

/// State for the inbox watcher lifecycle.
pub struct InboxState {
    active: Arc<AtomicBool>,
}

impl InboxState {
    pub fn new() -> Self {
        Self {
            active: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn is_active(&self) -> bool {
        self.active.load(Ordering::Relaxed)
    }
}

/// Parsed inbox file metadata from optional YAML frontmatter.
struct InboxMeta {
    title: Option<String>,
    folder: String,
    tags: Vec<String>,
    content: String,
}

/// Parse an inbox file's frontmatter (if present) and content.
#[allow(clippy::manual_strip)] // explicit slice keeps the frontmatter parsing readable
fn parse_inbox_file(content: &str) -> InboxMeta {
    let (frontmatter, body) = if content.starts_with("---\n") {
        if let Some(end) = content[4..].find("\n---\n") {
            let fm = &content[4..4 + end];
            let body = &content[4 + end + 5..];
            (Some(fm), body)
        } else {
            (None, content)
        }
    } else {
        (None, content)
    };

    let mut title = None;
    let mut folder = "general".to_string();
    let mut tags = Vec::new();

    if let Some(fm) = frontmatter {
        for line in fm.lines() {
            let line = line.trim();
            if let Some(v) = line.strip_prefix("title:") {
                title = Some(v.trim().trim_matches('"').trim_matches('\'').to_string());
            } else if let Some(v) = line.strip_prefix("folder:") {
                let f = v.trim().trim_matches('"').trim_matches('\'').to_string();
                // Validate folder name: reject traversal, dot-prefixed, and .securenotes
                if !f.is_empty()
                    && !f.contains('/')
                    && !f.contains('\\')
                    && !f.starts_with('.')
                    && f != ".."
                    && f != "."
                {
                    folder = f;
                }
            } else if let Some(v) = line.strip_prefix("tags:") {
                // Simple inline tag parsing: [tag1, tag2] or tag1, tag2
                let v = v.trim().trim_matches('[').trim_matches(']');
                tags = v
                    .split(',')
                    .map(|t| t.trim().trim_matches('"').trim_matches('\'').to_string())
                    .filter(|t| !t.is_empty())
                    .collect();
            }
        }
    }

    InboxMeta {
        title,
        folder,
        tags,
        content: body.to_string(),
    }
}

/// Whether a path found in `.inbox/` may be ingested.
///
/// Both entry points into the inbox — the sweep at unlock and the filesystem
/// watcher — must apply the same test. They did not: the sweep checked only the
/// file extension, so a symlink planted in `.inbox/` before the vault was
/// unlocked had its target read into a vault page and then committed and
/// synced, while the very same file was refused once the watcher was running.
///
/// A symlink is rejected outright rather than followed, and the resolved path
/// must still sit inside `.inbox/`, so neither a link nor a `..` component can
/// reach a file elsewhere on the machine.
fn is_ingestable(path: &Path, inbox_dir: &Path) -> bool {
    if !path.extension().is_some_and(|e| e == "md") {
        return false;
    }

    if path
        .symlink_metadata()
        .is_ok_and(|m| m.file_type().is_symlink())
    {
        log::warn!("[inbox] Ignoring symlink: {}", path.display());
        return false;
    }

    // An unreadable path is refused rather than admitted: this decides whether
    // to read a file into the vault, so uncertainty must not mean yes.
    let (Ok(canonical), Ok(canonical_inbox)) = (path.canonicalize(), inbox_dir.canonicalize())
    else {
        log::warn!("[inbox] Could not resolve {}; skipping", path.display());
        return false;
    };

    if !canonical.starts_with(&canonical_inbox) {
        log::warn!("[inbox] Path escapes inbox dir: {}", path.display());
        return false;
    }

    true
}

/// Move a file that could not be ingested into `.inbox/failed/`, contents
/// untouched.
///
/// The watcher runs `RecursiveMode::NonRecursive` and the startup sweep only
/// reads `*.md` sitting directly in `.inbox/`, so a quarantined file is neither
/// re-read nor retried in a loop. The destination name carries a timestamp so a
/// second failure cannot overwrite the first. If the move itself fails the file
/// simply stays where it is — under no circumstance is it deleted, because it
/// may be the only remaining copy of whatever it holds.
fn quarantine_inbox_file(file_path: &Path, vault_dir: &Path) {
    let failed_dir = vault_dir.join(".inbox").join("failed");
    if let Err(e) = std::fs::create_dir_all(&failed_dir) {
        log::error!(
            "[inbox] Could not create {}: {e}; leaving {} in place",
            failed_dir.display(),
            file_path.display()
        );
        return;
    }

    let Some(name) = file_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
    else {
        return;
    };
    let mut dest = failed_dir.join(&name);
    if dest.exists() {
        let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S");
        dest = failed_dir.join(format!("{stamp}-{name}"));
    }

    match std::fs::rename(file_path, &dest) {
        Ok(()) => log::warn!(
            "[inbox] Quarantined {} -> {}",
            file_path.display(),
            dest.display()
        ),
        Err(e) => log::error!(
            "[inbox] Could not quarantine {}: {e}; leaving it in place",
            file_path.display()
        ),
    }
}

/// Process a single inbox file: create page, encrypt, index, git save, delete file.
fn process_inbox_file(
    file_path: &Path,
    vault_dir: &Path,
    master_key: &[u8],
    search_engine: Option<&SearchEngine>,
    git_state: Option<&GitState>,
    app_handle: Option<&tauri::AppHandle>,
) {
    let file_content = match std::fs::read_to_string(file_path) {
        Ok(c) => c,
        Err(e) => {
            log::warn!("[inbox] Failed to read {}: {e}", file_path.display());
            return;
        }
    };

    let meta = parse_inbox_file(&file_content);

    // Derive title from frontmatter, filename, or first heading
    let title = meta.title.unwrap_or_else(|| {
        // Try first heading
        if let Some(heading) = meta.content.lines().find(|l| l.starts_with("# ")) {
            return heading.trim_start_matches('#').trim().to_string();
        }
        // Fall back to filename
        file_path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "Untitled".to_string())
    });

    // Encrypt secret blocks. A failure here must never fall through to writing
    // the file's contents as they are: the entire premise of the inbox is that a
    // dropped file may hold secrets. The previous fallback wrote them into the
    // vault as cleartext and then deleted the inbox file — frequently the only
    // other copy — leaving a `warn` line as the sole record. Quarantine instead.
    let encrypted_content = match secret::encrypt_secrets(&meta.content, master_key) {
        Ok(c) => c,
        Err(e) => {
            log::error!(
                "[inbox] Refusing to ingest {}: secret encryption failed: {e}",
                file_path.display()
            );
            quarantine_inbox_file(file_path, vault_dir);
            return;
        }
    };

    // Create the page
    match crud::create_page(vault_dir, &title, &meta.folder, &encrypted_content, false) {
        Ok(mut page) => {
            // Update tags if provided
            if !meta.tags.is_empty() {
                if let Ok(updated) = crud::update_tags(vault_dir, &page.path, meta.tags) {
                    page = updated;
                }
            }

            // Index for search
            if let Some(engine) = search_engine {
                page.content = meta.content;
                let doc = page_to_document(&page);
                let _ = engine.index_page(&doc);
            }

            // Record git save
            if let Some(git) = git_state {
                let _ = git.batcher.record_save(&title);
            }

            log::info!("[inbox] Ingested: {} -> {}", file_path.display(), page.path);

            // Notify frontend
            if let Some(app) = app_handle {
                let _ = app.emit("pages-changed", ());
            }

            // Delete the inbox file
            if let Err(e) = std::fs::remove_file(file_path) {
                log::warn!("[inbox] Failed to delete {}: {e}", file_path.display());
            }
        }
        Err(e) => {
            log::warn!(
                "[inbox] Failed to create page from {}: {e}",
                file_path.display()
            );
        }
    }
}

/// Start the inbox watcher. Spawns a background thread that watches `.inbox/`.
pub fn start_inbox_watcher(
    vault_dir: PathBuf,
    master_key: Zeroizing<Vec<u8>>,
    inbox_state: &InboxState,
    search_state: &SearchState,
    git_state: &GitState,
    app_handle: Option<tauri::AppHandle>,
) {
    if inbox_state.is_active() {
        return;
    }

    let inbox_dir = vault_dir.join(".inbox");
    if std::fs::create_dir_all(&inbox_dir).is_err() {
        log::warn!("[inbox] Failed to create inbox directory");
        return;
    }

    inbox_state.active.store(true, Ordering::Relaxed);
    let active = inbox_state.active.clone();

    // Process any existing files first
    if let Ok(entries) = std::fs::read_dir(&inbox_dir) {
        let search_guard = search_state.engine.lock().ok();
        let search_engine = search_guard.as_ref().and_then(|g| g.as_ref());

        for entry in entries.flatten() {
            let path = entry.path();
            if is_ingestable(&path, &inbox_dir) {
                process_inbox_file(
                    &path,
                    &vault_dir,
                    &master_key,
                    search_engine,
                    Some(git_state),
                    app_handle.as_ref(),
                );
            }
        }
    }

    // Clone state references for the watcher thread
    let vd = vault_dir.clone();
    let key = master_key;
    let inbox_path = inbox_dir.clone();
    let app = app_handle;

    std::thread::spawn(move || {
        let (tx, rx) = std::sync::mpsc::channel();
        let mut watcher = match RecommendedWatcher::new(tx, Config::default()) {
            Ok(w) => w,
            Err(e) => {
                log::error!("[inbox] Failed to create watcher: {e}");
                active.store(false, Ordering::Relaxed);
                return;
            }
        };

        if let Err(e) = watcher.watch(&inbox_path, RecursiveMode::NonRecursive) {
            log::error!("[inbox] Failed to watch {}: {e}", inbox_path.display());
            active.store(false, Ordering::Relaxed);
            return;
        }

        log::info!("[inbox] Watching {}", inbox_path.display());

        while active.load(Ordering::Relaxed) {
            match rx.recv_timeout(std::time::Duration::from_secs(1)) {
                Ok(Ok(event)) => {
                    if matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_)) {
                        for path in event.paths {
                            if is_ingestable(&path, &inbox_path) {
                                // Small delay for file to finish writing
                                std::thread::sleep(std::time::Duration::from_millis(200));
                                // No search engine or git state in the thread — just create the page
                                process_inbox_file(&path, &vd, &key, None, None, app.as_ref());
                            }
                        }
                    }
                }
                Ok(Err(e)) => {
                    log::warn!("[inbox] Watch error: {e}");
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }

        log::info!("[inbox] Watcher stopped");
    });
}

/// Stop the inbox watcher.
pub fn stop_inbox_watcher(inbox_state: &InboxState) {
    inbox_state.active.store(false, Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_inbox_no_frontmatter() {
        let meta = parse_inbox_file("# My Note\n\nSome content here.");
        assert!(meta.title.is_none());
        assert_eq!(meta.folder, "general");
        assert!(meta.tags.is_empty());
        assert!(meta.content.contains("My Note"));
    }

    #[test]
    fn parse_inbox_with_frontmatter() {
        let input = "---\ntitle: Test Page\nfolder: work\ntags: [rust, dev]\n---\nBody text";
        let meta = parse_inbox_file(input);
        assert_eq!(meta.title.as_deref(), Some("Test Page"));
        assert_eq!(meta.folder, "work");
        assert_eq!(meta.tags, vec!["rust", "dev"]);
        assert_eq!(meta.content, "Body text");
    }

    /// A dropped file that cannot be encrypted must not be ingested, and must
    /// not be deleted.
    ///
    /// The old behaviour fell back to `meta.content.clone()` on any encryption
    /// error — writing the file's secrets into the vault as cleartext — and then
    /// deleted the inbox file, which was often the only other copy. A
    /// `log::warn!` was the sole record. This is the exact shape of a fail-open:
    /// the error path was strictly less safe than the success path.
    #[test]
    fn failed_encryption_quarantines_instead_of_writing_plaintext() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        std::fs::create_dir_all(vault.join("general")).unwrap();
        let inbox = vault.join(".inbox");
        std::fs::create_dir_all(&inbox).unwrap();

        let dropped = inbox.join("drop.md");
        let body = ":::secret[API]\npassword: leaky-inbox-value\n:::\n";
        std::fs::write(&dropped, body).unwrap();

        // AES-256-GCM rejects a key that is not 32 bytes, which is the class of
        // failure the fallback used to swallow.
        let unusable_key = vec![0u8; 16];
        process_inbox_file(&dropped, vault, &unusable_key, None, None, None);

        // Nothing anywhere in the vault may hold the value in cleartext.
        for entry in walkdir::WalkDir::new(vault).into_iter().flatten() {
            let path = entry.path();
            if !path.is_file() || path.starts_with(inbox.join("failed")) {
                continue;
            }
            let contents = std::fs::read_to_string(path).unwrap_or_default();
            assert!(
                !contents.contains("leaky-inbox-value"),
                "secret written in plaintext to {}",
                path.display()
            );
        }

        // The source is preserved, byte for byte, out of the watcher's way.
        let quarantined = inbox.join("failed").join("drop.md");
        assert!(
            quarantined.exists(),
            "the dropped file was neither ingested nor kept"
        );
        assert_eq!(
            std::fs::read_to_string(&quarantined).unwrap(),
            body,
            "the quarantined file was modified"
        );
        assert!(
            !dropped.exists(),
            "the file should have moved out of the watched directory"
        );
    }

    /// A symlink dropped into `.inbox/` must never be read, whichever entry
    /// point finds it.
    ///
    /// The unlock sweep checked only the file extension while the watcher
    /// checked for symlinks and path escapes, so planting a link BEFORE
    /// unlocking read its target into a vault page — which was then committed
    /// and synced. Both paths now share this test.
    #[cfg(unix)]
    #[test]
    fn a_symlink_in_the_inbox_is_never_ingestable() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        let inbox = vault.join(".inbox");
        std::fs::create_dir_all(&inbox).unwrap();

        let outside = vault.join("private.md");
        std::fs::write(&outside, "# not for the vault\n").unwrap();

        let link = inbox.join("innocent.md");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        assert!(
            !is_ingestable(&link, &inbox),
            "a symlink was accepted for ingestion"
        );

        // A real file in the same directory is still accepted.
        let genuine = inbox.join("note.md");
        std::fs::write(&genuine, "# a real note\n").unwrap();
        assert!(is_ingestable(&genuine, &inbox));

        // Non-markdown is ignored regardless.
        let other = inbox.join("note.txt");
        std::fs::write(&other, "text").unwrap();
        assert!(!is_ingestable(&other, &inbox));
    }

    /// A path that resolves outside `.inbox/` is refused, and so is one that
    /// cannot be resolved at all — this decides whether to read a file into the
    /// vault, so uncertainty must not mean yes.
    #[test]
    fn paths_outside_the_inbox_are_never_ingestable() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        let inbox = vault.join(".inbox");
        std::fs::create_dir_all(&inbox).unwrap();

        let elsewhere = vault.join("elsewhere.md");
        std::fs::write(&elsewhere, "# elsewhere\n").unwrap();
        assert!(!is_ingestable(&elsewhere, &inbox));

        assert!(!is_ingestable(&inbox.join("does-not-exist.md"), &inbox));
    }
}
