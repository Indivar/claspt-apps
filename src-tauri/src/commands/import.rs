// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Tauri IPC commands for importing secrets from other password managers.
//!
//! Handles CSV/XML exports from tools such as LastPass, 1Password, and RoboForm (plus
//! generic CSV): detecting columns, previewing the parsed entries before committing,
//! de-duplicating titles within a folder, and finally creating/updating pages with the
//! values encrypted into `:::secret` blocks. Long imports run off the UI thread and emit
//! `import-progress` events. Errors surface to the frontend as `ImportCommandError`.
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use zeroize::Zeroizing;

use super::crypto::VaultState;
use super::git::{record_save_if_active, GitState};
use super::search::{index_page_if_active, index_pages_batch_if_active, SearchState};
use crate::import::error::ImportError;
use crate::import::formats::{
    self, CsvColumnMapping, ImportEntry, ImportFormat, MarkdownImportPreview,
};
use crate::pages::crud;
use crate::pages::error::PageError;
use crate::pages::model::Page;
use crate::pages::secret;

/// Validate that an import file path has an expected extension (defense-in-depth).
/// Normal usage is constrained by Tauri's file dialog, but this guards against
/// direct IPC calls from a compromised webview.
fn validate_import_path(path: &Path, format: &ImportFormat) -> Result<(), ImportCommandError> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let valid = match format {
        ImportFormat::LastPass
        | ImportFormat::OnePassword
        | ImportFormat::RoboForm
        | ImportFormat::GenericCsv => ext == "csv",
        ImportFormat::KeePass => ext == "xml",
        ImportFormat::Markdown => ext == "md" || ext == "markdown",
        ImportFormat::ClasptJson => ext == "json",
    };
    if !valid {
        return Err(ImportCommandError::Import(format!(
            "unexpected file extension '.{}' for {:?} import",
            ext, format
        )));
    }
    if !path.is_file() {
        return Err(ImportCommandError::Import("file not found".to_string()));
    }
    Ok(())
}

/// Result of an import operation with duplicate tracking.
#[derive(Debug, Clone, Serialize)]
pub struct ImportResult {
    pub imported: usize,
    pub skipped: usize,
    pub total: usize,
}

#[derive(Debug, Serialize)]
pub enum ImportCommandError {
    Import(String),
    Page(String),
}

impl From<ImportError> for ImportCommandError {
    fn from(e: ImportError) -> Self {
        ImportCommandError::Import(e.to_string())
    }
}

impl From<PageError> for ImportCommandError {
    fn from(e: PageError) -> Self {
        ImportCommandError::Page(e.to_string())
    }
}

/// Detect CSV column headers and return auto-mapped roles.
#[tauri::command]
pub fn detect_csv_columns(file_path: String) -> Result<Vec<CsvColumnMapping>, ImportCommandError> {
    let path = PathBuf::from(&file_path);
    validate_import_path(&path, &ImportFormat::GenericCsv)?;
    let mappings = formats::detect_csv_columns(&path)?;
    Ok(mappings)
}

/// Preview entries from an import file without creating any pages.
#[tauri::command]
pub fn preview_import(
    file_path: String,
    format: ImportFormat,
    column_mappings: Option<Vec<CsvColumnMapping>>,
) -> Result<Vec<ImportEntry>, ImportCommandError> {
    let path = PathBuf::from(&file_path);
    validate_import_path(&path, &format)?;
    let entries = formats::parse_import(&path, &format, column_mappings.as_deref())?;
    Ok(entries)
}

/// Progress payload emitted during bulk import.
#[derive(Debug, Clone, Serialize)]
struct ImportProgress {
    imported: usize,
    skipped: usize,
    total: usize,
}

/// Import entries from a file, creating pages with secret blocks.
/// Detects duplicates by (title, folder) and handles them per the chosen strategy:
/// - "skip": don't import duplicates (default)
/// - "overwrite": replace existing page content with imported version
/// - "import_as_new": create with " (2)" suffix (or incrementing) on title
/// Emits `import-progress` events so the frontend can show a progress bar.
#[tauri::command]
pub async fn execute_import(
    file_path: String,
    format: ImportFormat,
    duplicate_strategy: String,
    column_mappings: Option<Vec<CsvColumnMapping>>,
    app: AppHandle,
    state: State<'_, VaultState>,
    search_state: State<'_, SearchState>,
    git_state: State<'_, GitState>,
) -> Result<ImportResult, ImportCommandError> {
    let path = PathBuf::from(&file_path);
    validate_import_path(&path, &format)?;

    let vault_dir = state
        .vault_path
        .lock()
        .map_err(|_| ImportCommandError::Page("Lock poisoned".to_string()))?
        .clone()
        .ok_or(ImportCommandError::Page("Vault not open".to_string()))?;

    let master_key = Zeroizing::new(
        state
            .master_key
            .lock()
            .map_err(|_| ImportCommandError::Page("Lock poisoned".to_string()))?
            .clone()
            .ok_or(ImportCommandError::Page("Vault not open".to_string()))?,
    );

    // Run the bulk import on a blocking thread (file parsing + many page writes)
    let (imported_pages, result) = tokio::task::spawn_blocking(move || {
        let entries = formats::parse_import(&path, &format, column_mappings.as_deref())?;
        let total = entries.len();

        let existing_pages = crud::list_pages(&vault_dir).unwrap_or_default();
        let existing_map: HashMap<(String, String), String> = existing_pages
            .iter()
            .map(|p| {
                (
                    (p.meta.title.to_lowercase(), p.meta.folder.to_lowercase()),
                    p.path.clone(),
                )
            })
            .collect();

        let mut titles_in_folder: HashMap<String, HashSet<String>> = HashMap::new();
        if duplicate_strategy == "import_as_new" {
            for p in &existing_pages {
                titles_in_folder
                    .entry(p.meta.folder.to_lowercase())
                    .or_default()
                    .insert(p.meta.title.to_lowercase());
            }
        }

        let mut imported = 0;
        let mut skipped = 0;
        let mut imported_pages: Vec<Page> = Vec::new();

        for (i, entry) in entries.iter().enumerate() {
            let key = (entry.title.to_lowercase(), entry.folder.to_lowercase());
            let is_duplicate = existing_map.contains_key(&key);

            if is_duplicate {
                match duplicate_strategy.as_str() {
                    "overwrite" => {
                        let existing_path = &existing_map[&key];
                        let content = formats::entry_to_page_content(entry);
                        let encrypted = secret::encrypt_secrets(&content, &master_key)
                            .map_err(|e| ImportCommandError::Page(e.to_string()))?;

                        let mut page = crud::update_page(&vault_dir, existing_path, &encrypted)?;
                        page.content = content;
                        imported_pages.push(page);
                        imported += 1;
                    }
                    "import_as_new" => {
                        let new_title =
                            deduplicate_title(&entry.title, &entry.folder, &mut titles_in_folder);
                        let content = formats::entry_to_page_content(entry);
                        let encrypted = secret::encrypt_secrets(&content, &master_key)
                            .map_err(|e| ImportCommandError::Page(e.to_string()))?;

                        let mut page = crud::create_page(
                            &vault_dir,
                            &new_title,
                            &entry.folder,
                            &encrypted,
                            false,
                        )?;
                        page.content = content;
                        imported_pages.push(page);
                        imported += 1;
                    }
                    _ => {
                        skipped += 1;
                    }
                }
            } else {
                let content = formats::entry_to_page_content(entry);
                let encrypted = secret::encrypt_secrets(&content, &master_key)
                    .map_err(|e| ImportCommandError::Page(e.to_string()))?;

                let mut page =
                    crud::create_page(&vault_dir, &entry.title, &entry.folder, &encrypted, false)?;

                page.content = content;
                imported_pages.push(page);
                imported += 1;

                if duplicate_strategy == "import_as_new" {
                    titles_in_folder
                        .entry(entry.folder.to_lowercase())
                        .or_default()
                        .insert(entry.title.to_lowercase());
                }
            }

            // Emit progress every 10 entries or on the last one
            if (i + 1) % 10 == 0 || i + 1 == total {
                let _ = app.emit(
                    "import-progress",
                    ImportProgress {
                        imported,
                        skipped,
                        total,
                    },
                );
            }
        }

        Ok::<_, ImportCommandError>((
            imported_pages,
            ImportResult {
                imported,
                skipped,
                total,
            },
        ))
    })
    .await
    .map_err(|e| ImportCommandError::Page(format!("task join error: {e}")))??;

    // Batch index all imported pages in a single tantivy commit
    if !imported_pages.is_empty() {
        index_pages_batch_if_active(&imported_pages, &search_state);
        record_save_if_active(&format!("Import {} entries", result.imported), &git_state);
    }

    Ok(result)
}

/// Find a unique title by appending " (2)", " (3)", etc.
fn deduplicate_title(
    base_title: &str,
    folder: &str,
    titles_in_folder: &mut HashMap<String, HashSet<String>>,
) -> String {
    let folder_lc = folder.to_lowercase();
    let titles = titles_in_folder.entry(folder_lc).or_default();

    let mut n = 2;
    loop {
        let candidate = format!("{} ({})", base_title, n);
        if !titles.contains(&candidate.to_lowercase()) {
            titles.insert(candidate.to_lowercase());
            return candidate;
        }
        n += 1;
    }
}

/// Preview a markdown file for import — extracts title, tags, folder from frontmatter.
#[tauri::command]
pub fn preview_markdown_import(
    file_path: String,
    state: State<VaultState>,
) -> Result<MarkdownImportPreview, ImportCommandError> {
    let path = PathBuf::from(&file_path);
    validate_import_path(&path, &ImportFormat::Markdown)?;

    let mut preview = formats::parse_markdown_preview(&path)?;

    // Check for duplicate (title, folder) in existing pages
    let vault_dir = state
        .vault_path
        .lock()
        .map_err(|_| ImportCommandError::Page("Lock poisoned".to_string()))?
        .clone()
        .ok_or(ImportCommandError::Page("Vault not open".to_string()))?;

    let existing: HashSet<(String, String)> = crud::list_pages(&vault_dir)
        .unwrap_or_default()
        .iter()
        .map(|p| (p.meta.title.to_lowercase(), p.meta.folder.to_lowercase()))
        .collect();

    let key = (
        preview.title.to_lowercase(),
        preview.suggested_folder.to_lowercase(),
    );
    if existing.contains(&key) {
        preview.duplicate_exists = true;
        preview
            .warnings
            .push("A page with this title already exists in the target folder".to_string());
    }

    Ok(preview)
}

/// Import a markdown file as a vault page.
#[tauri::command]
pub fn import_markdown_page(
    file_path: String,
    title: String,
    folder: String,
    tags: Vec<String>,
    state: State<VaultState>,
    search_state: State<SearchState>,
    git_state: State<GitState>,
) -> Result<Page, ImportCommandError> {
    let path = PathBuf::from(&file_path);
    validate_import_path(&path, &ImportFormat::Markdown)?;

    let vault_dir = state
        .vault_path
        .lock()
        .map_err(|_| ImportCommandError::Page("Lock poisoned".to_string()))?
        .clone()
        .ok_or(ImportCommandError::Page("Vault not open".to_string()))?;

    let master_key = Zeroizing::new(
        state
            .master_key
            .lock()
            .map_err(|_| ImportCommandError::Page("Lock poisoned".to_string()))?
            .clone()
            .ok_or(ImportCommandError::Page("Vault not open".to_string()))?,
    );

    // Re-read and validate the file
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| ImportCommandError::Import(format!("Failed to read file: {}", e)))?;
    let body = formats::strip_frontmatter(&raw);

    // Encrypt any :::secret blocks
    let encrypted = secret::encrypt_secrets(&body, &master_key)
        .map_err(|e| ImportCommandError::Page(e.to_string()))?;

    // Create the page
    let mut page = crud::create_page(&vault_dir, &title, &folder, &encrypted, false)?;

    // Update tags if provided
    if !tags.is_empty() {
        page = crud::update_tags(&vault_dir, &page.path, tags)?;
    }

    // Index for search (use decrypted content)
    page.content = body;
    index_page_if_active(&page, &search_state);

    // Git commit
    record_save_if_active(&format!("Import: {}", title), &git_state);

    Ok(page)
}
