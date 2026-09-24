// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Import all `.md` files from a folder into the vault.
//!
//! Recursively collects markdown files under a source directory (skipping
//! hidden dirs), preserving the relative subfolder structure under the chosen
//! target folder. Each file's title is taken from YAML frontmatter or a leading
//! `#` heading (falling back to the filename), and any `:::secret` blocks are
//! encrypted with the vault master key before the page is written.

use serde::Serialize;
use std::path::{Path, PathBuf};

use crate::pages::crud;
use crate::pages::error::PageError;
use crate::pages::secret;

/// Outcome of a folder import.
#[derive(Debug, Serialize)]
pub struct ImportFolderResult {
    /// Number of files successfully imported as pages.
    pub imported: usize,
    /// Number of files skipped (e.g. unreadable filename).
    pub skipped: usize,
    /// Per-file error messages for files that failed to import.
    pub errors: Vec<String>,
}

/// Import all `.md` files from `source_folder` into `target_folder` in the vault.
/// Secret blocks in imported files are encrypted with the vault's master key.
pub fn import_folder(
    vault_dir: &Path,
    master_key: &[u8],
    source_folder: &str,
    target_folder: &str,
) -> Result<ImportFolderResult, PageError> {
    let source = PathBuf::from(source_folder);
    if !source.is_dir() {
        return Err(PageError::NotFound(format!(
            "Source folder not found: {}",
            source_folder
        )));
    }

    // Ensure target folder exists in vault
    let target_dir = vault_dir.join(target_folder);
    std::fs::create_dir_all(&target_dir)?;

    let mut imported = 0;
    let mut skipped = 0;
    let mut errors = Vec::new();

    // Collect .md files (non-recursive for safety; use walk for nested)
    let md_files = collect_md_files(&source)?;

    for md_path in &md_files {
        let file_name = match md_path.file_stem() {
            Some(s) => s.to_string_lossy().to_string(),
            None => {
                skipped += 1;
                continue;
            }
        };

        // Read file content
        let raw = match std::fs::read_to_string(md_path) {
            Ok(c) => c,
            Err(e) => {
                errors.push(format!("{}: {}", file_name, e));
                continue;
            }
        };

        // Extract title from YAML frontmatter or filename
        let (title, body) = extract_title_and_body(&raw, &file_name);

        // Encrypt any :::secret blocks
        let encrypted_body = match secret::encrypt_secrets(&body, master_key) {
            Ok(b) => b,
            Err(e) => {
                errors.push(format!("{}: failed to encrypt secrets: {}", title, e));
                continue;
            }
        };

        // Preserve subfolder structure: compute relative path from source root
        let page_folder = if let Ok(rel) = md_path.parent().unwrap_or(&source).strip_prefix(&source)
        {
            let rel_str = crate::pages::slash_path(rel);
            if rel_str.is_empty() {
                target_folder.to_string()
            } else {
                format!("{}/{}", target_folder, rel_str)
            }
        } else {
            target_folder.to_string()
        };

        // Ensure the subfolder exists in the vault
        let sub_dir = vault_dir.join(&page_folder);
        if !sub_dir.exists() {
            std::fs::create_dir_all(&sub_dir)?;
        }

        // Create the page in the correct subfolder
        match crud::create_page(vault_dir, &title, &page_folder, &encrypted_body, false) {
            Ok(_) => imported += 1,
            Err(e) => {
                errors.push(format!("{}: {}", title, e));
            }
        }
    }

    Ok(ImportFolderResult {
        imported,
        skipped,
        errors,
    })
}

/// Collect all `.md` files recursively from a directory.
fn collect_md_files(dir: &Path) -> Result<Vec<PathBuf>, PageError> {
    let mut files = Vec::new();
    collect_md_recursive(dir, &mut files)?;
    files.sort();
    Ok(files)
}

fn collect_md_recursive(dir: &Path, files: &mut Vec<PathBuf>) -> Result<(), PageError> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            // Skip hidden directories
            if path
                .file_name()
                .is_some_and(|n| n.to_string_lossy().starts_with('.'))
            {
                continue;
            }
            collect_md_recursive(&path, files)?;
        } else if path
            .extension()
            .is_some_and(|e| e == "md" || e == "markdown")
        {
            files.push(path);
        }
    }
    Ok(())
}

/// Extract title from YAML frontmatter `title:` field, or derive from filename.
fn extract_title_and_body(raw: &str, fallback_title: &str) -> (String, String) {
    if raw.starts_with("---\n") || raw.starts_with("---\r\n") {
        if let Some(end) = raw[3..].find("\n---") {
            let frontmatter = &raw[4..3 + end];
            let body = &raw[3 + end + 4..]; // skip past closing ---\n

            // Simple YAML title extraction
            for line in frontmatter.lines() {
                let trimmed = line.trim();
                if let Some(rest) = trimmed.strip_prefix("title:") {
                    let title = rest.trim().trim_matches('"').trim_matches('\'').to_string();
                    if !title.is_empty() {
                        return (title, body.trim_start_matches('\n').to_string());
                    }
                }
            }

            // Frontmatter exists but no title field — use body without frontmatter
            return (
                fallback_title.to_string(),
                body.trim_start_matches('\n').to_string(),
            );
        }
    }

    // No frontmatter — check if first line is a heading
    let first_line = raw.lines().next().unwrap_or("");
    if let Some(heading) = first_line.strip_prefix("# ") {
        let title = heading.trim().to_string();
        let body = raw[first_line.len()..].trim_start_matches('\n').to_string();
        return (title, body);
    }

    (fallback_title.to_string(), raw.to_string())
}
