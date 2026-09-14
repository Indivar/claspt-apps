// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Tauri IPC commands for full-text search over the vault.
//!
//! Wraps the tantivy-backed `SearchEngine` (held in Tauri managed state) with commands to
//! initialize/rebuild the index when the vault opens, query it with field boosts (title,
//! tags, secret labels, content), and incrementally add/update/remove documents as pages
//! change. Note that only plaintext is indexed — decrypted secret *values* are never
//! written to the index, only their labels. Errors surface as `SearchError`.
use std::sync::Mutex;

use tauri::State;

use super::crypto::VaultState;
use crate::pages::{crud, model, secret};
use crate::search::engine::{PageDocument, SearchEngine, SearchResult, SearchScope};
use crate::search::error::SearchError;

/// Holds the search engine instance in Tauri managed state.
pub struct SearchState {
    pub engine: Mutex<Option<SearchEngine>>,
}

impl SearchState {
    pub fn new() -> Self {
        Self {
            engine: Mutex::new(None),
        }
    }
}

fn get_engine<'a>(
    guard: &'a std::sync::MutexGuard<'_, Option<SearchEngine>>,
) -> Result<&'a SearchEngine, SearchError> {
    guard.as_ref().ok_or(SearchError::VaultNotOpen)
}

/// Initialize the search engine for the current vault.
/// Called automatically when a vault is unlocked.
/// If the index is corrupted, it will be deleted and rebuilt from scratch.
pub fn init_search_engine(
    vault_dir: &std::path::Path,
    search_state: &SearchState,
) -> Result<(), SearchError> {
    let index_dir = vault_dir.join(".securenotes").join("index");
    let engine = match SearchEngine::open(&index_dir) {
        Ok(engine) => engine,
        Err(e) => {
            log::warn!("Search index corrupted, rebuilding: {}", e);
            if index_dir.exists() {
                let _ = std::fs::remove_dir_all(&index_dir);
            }
            let engine = SearchEngine::open(&index_dir)?;

            // Re-index all pages into the fresh index
            let pages = crud::list_pages(vault_dir).map_err(|e| {
                SearchError::Index(format!("failed to list pages for rebuild: {e}"))
            })?;
            let mut documents = Vec::with_capacity(pages.len());
            for summary in &pages {
                if let Ok(page) = crud::read_page(vault_dir, &summary.path) {
                    documents.push(page_to_document(&page));
                }
            }
            if !documents.is_empty() {
                engine.rebuild(&documents)?;
            }
            log::info!("Search index rebuilt with {} pages", documents.len());
            engine
        }
    };
    *search_state
        .engine
        .lock()
        .map_err(|_| SearchError::LockPoisoned)? = Some(engine);
    Ok(())
}

/// Shut down the search engine (called on vault lock).
pub fn close_search_engine(search_state: &SearchState) {
    if let Ok(mut guard) = search_state.engine.lock() {
        *guard = None;
    }
}

/// Convert a page from disk into a PageDocument for indexing.
///
/// Encrypted pages (full-body encryption) have their content and secret
/// labels excluded from the index — only title, tags, and folder remain
/// searchable.
pub(crate) fn page_to_document(page: &model::Page) -> PageDocument {
    if page.meta.encrypted {
        return PageDocument {
            page_id: page.meta.id.clone(),
            title: page.meta.title.clone(),
            content: String::new(),
            tags: page.meta.tags.join(" "),
            secret_labels: String::new(),
            folder: page.meta.folder.clone(),
            path: page.path.clone(),
            has_secrets: false,
        };
    }

    let labels = secret::extract_secret_labels(&page.content);
    let stripped_content = crate::search::engine::strip_secret_values(&page.content);

    PageDocument {
        page_id: page.meta.id.clone(),
        title: page.meta.title.clone(),
        content: stripped_content,
        tags: page.meta.tags.join(" "),
        secret_labels: labels.join(" "),
        folder: page.meta.folder.clone(),
        path: page.path.clone(),
        has_secrets: !labels.is_empty(),
    }
}

/// Run a full-text query against the tantivy index within `scope`, returning up to 50
/// ranked results. Errors as `SearchError` if the index lock is poisoned or the engine is
/// not initialized (no vault open).
///
/// When `include_ai_memory` is false, pages under the `ai/memory/` tree (the
/// AI agent's memory store) are excluded from results — the search overlay
/// exposes this as a user-toggleable checkbox (default on).
#[tauri::command]
pub fn search_pages(
    query: String,
    scope: SearchScope,
    include_ai_memory: bool,
    limit: usize,
    state: State<SearchState>,
) -> Result<Vec<SearchResult>, SearchError> {
    // Clamp the caller-supplied page size so a client can't request an unbounded
    // fetch. The search overlay grows this as the user scrolls (load-more): it
    // re-queries with a larger `limit` and treats `results.len() == limit` as
    // "more results may exist".
    let limit = limit.clamp(1, 500);
    let guard = state.engine.lock().map_err(|_| SearchError::LockPoisoned)?;
    let engine = get_engine(&guard)?;
    if include_ai_memory {
        return engine.search(&query, &scope, limit);
    }
    // Over-fetch, drop AI-memory pages, then trim to the page size — so
    // excluding memory doesn't starve the page and keeps `results.len() ==
    // limit` a reliable "more results exist" signal.
    let mut results = engine.search(&query, &scope, limit.saturating_mul(2))?;
    results.retain(|r| !r.path.starts_with("ai/memory/"));
    results.truncate(limit);
    Ok(results)
}

/// Rebuild the entire search index from scratch by reading every page (on a blocking
/// thread) and re-indexing it. Returns the number of documents indexed. Used after bulk
/// changes or to recover a corrupt index.
#[tauri::command]
pub async fn rebuild_search_index(
    vault_state: State<'_, VaultState>,
    search_state: State<'_, SearchState>,
) -> Result<usize, SearchError> {
    let vault_dir = vault_state.vault_dir().ok_or(SearchError::VaultNotOpen)?;

    // Read all pages on a blocking thread (scales with vault size)
    let documents = tokio::task::spawn_blocking(move || {
        let pages = crud::list_pages(&vault_dir)
            .map_err(|e| SearchError::Index(format!("failed to list pages: {e}")))?;

        let mut documents = Vec::with_capacity(pages.len());
        for summary in &pages {
            if let Ok(page) = crud::read_page(&vault_dir, &summary.path) {
                documents.push(page_to_document(&page));
            }
        }
        Ok::<_, SearchError>(documents)
    })
    .await
    .map_err(|e| SearchError::Index(format!("task join error: {e}")))??;

    let count = documents.len();

    let guard = search_state
        .engine
        .lock()
        .map_err(|_| SearchError::LockPoisoned)?;
    let engine = get_engine(&guard)?;
    engine.rebuild(&documents)?;

    Ok(count)
}

/// Index a single page after it's been created or updated.
/// Called internally from page commands.
///
/// Uses `catch_unwind` so that an unexpected panic in the search engine
/// (e.g. from content with unusual characters) degrades search gracefully
/// instead of crashing the entire application.
pub fn index_page_if_active(page: &model::Page, search_state: &State<SearchState>) {
    let Ok(guard) = search_state.engine.lock() else {
        return;
    };
    if let Some(engine) = guard.as_ref() {
        let doc = page_to_document(page);
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| engine.index_page(&doc))) {
            Ok(Ok(())) => {}
            Ok(Err(e)) => log::error!("Search index update failed for '{}': {e}", page.meta.title),
            Err(_) => log::error!(
                "Search index panicked while indexing '{}' — search may be stale",
                page.meta.title
            ),
        }
    }
}

/// Index multiple pages in a single batch (one commit).
/// Called from bulk import for performance.
pub fn index_pages_batch_if_active(pages: &[model::Page], search_state: &State<SearchState>) {
    let Ok(guard) = search_state.engine.lock() else {
        return;
    };
    if let Some(engine) = guard.as_ref() {
        let docs: Vec<_> = pages.iter().map(page_to_document).collect();
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            engine.index_pages_batch(&docs)
        })) {
            Ok(Ok(())) => {}
            Ok(Err(e)) => log::error!("Search batch index failed: {e}"),
            Err(_) => log::error!("Search batch index panicked — search may be stale"),
        }
    }
}

/// Remove a page from the search index.
/// Called internally when a page is deleted.
pub fn remove_page_if_active(page_id: &str, search_state: &State<SearchState>) {
    let Ok(guard) = search_state.engine.lock() else {
        return;
    };
    if let Some(engine) = guard.as_ref() {
        if let Err(e) = engine.remove_page(page_id) {
            log::error!("Search index remove failed for page {page_id}: {e}");
        }
    }
}
