// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Tauri IPC commands for exporting and importing the vault as portable archives.
//!
//! Covers full-vault export (a ZIP of the `.md` pages, optionally AES-encrypted with a
//! passphrase), plaintext secret export to CSV/JSON (which decrypts secret blocks — a
//! deliberately sensitive operation), and importing a previously exported ZIP back into a
//! vault. CSV output is sanitized against spreadsheet formula injection. Errors surface to
//! the frontend as `PageError`.
use std::collections::BTreeMap;
use std::io::Write;
use tauri::State;
use zeroize::Zeroizing;

use crate::commands::crypto::VaultState;
use crate::pages::error::PageError;
use crate::pages::{crud, model, secret};
use std::path::Path;

fn get_vault_dir(state: &State<VaultState>) -> Result<std::path::PathBuf, PageError> {
    state.vault_dir().ok_or(PageError::VaultNotOpen)
}

fn get_master_key(state: &State<VaultState>) -> Result<Zeroizing<Vec<u8>>, PageError> {
    state.master_key().ok_or(PageError::VaultNotOpen)
}

/// Result summary returned to the frontend after export.
#[derive(Debug, serde::Serialize)]
pub struct ExportResult {
    pub pages_exported: usize,
    pub secrets_exported: usize,
    pub file_path: String,
}

/// Export the entire vault as a .zip with secrets decrypted inline.
///
/// If `password` is provided and non-empty, the zip is AES-256 encrypted.
/// Otherwise, the zip is unprotected.
#[tauri::command]
pub fn export_vault_complete(
    file_path: String,
    password: Option<String>,
    state: State<VaultState>,
) -> Result<ExportResult, PageError> {
    let vault_dir = get_vault_dir(&state)?;
    let master_key = get_master_key(&state)?;

    let out_file = std::fs::File::create(&file_path)?;
    let mut zip = zip::ZipWriter::new(out_file);

    let has_password = password.as_ref().is_some_and(|p| !p.is_empty());

    let options = if has_password {
        zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .with_aes_encryption(
                zip::AesMode::Aes256,
                password.as_deref().unwrap_or_default(),
            )
    } else {
        zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
    };

    let mut pages_count = 0usize;
    let mut secrets_count = 0usize;

    crud::walk_vault_pages(&vault_dir, |rel_path, meta, content| {
        // Exports must always be plaintext-portable. Use the _for_export
        // variants that replace undecryptable blocks with a visible
        // placeholder instead of leaking `enc:v1:` ciphertext into the zip.
        let decrypted = if meta.encrypted {
            let body = secret::decrypt_full_body_for_export(&content, &master_key);
            secret::decrypt_secrets_for_export(&body, &master_key).unwrap_or(body)
        } else {
            secret::decrypt_secrets_for_export(&content, &master_key)
                .unwrap_or_else(|_| content.clone())
        };

        secrets_count += secret::extract_secret_labels(&content).len();

        // Exported pages must not carry the `encrypted: true` flag — the
        // body is plaintext now and any downstream tool (including a fresh
        // Claspt import) needs to treat it as plaintext.
        let mut export_meta = meta.clone();
        export_meta.encrypted = false;

        let full_page = match model::serialize_page(&export_meta, &decrypted) {
            Ok(s) => s,
            Err(_) => return,
        };

        if zip.start_file(&rel_path, options).is_ok() {
            let _ = zip.write_all(full_page.as_bytes());
            pages_count += 1;
        }
    })?;

    zip.finish()
        .map_err(|e| std::io::Error::other(format!("zip finalize: {e}")))?;

    Ok(ExportResult {
        pages_exported: pages_count,
        secrets_exported: secrets_count,
        file_path,
    })
}

/// A single secret entry for JSON export.
/// Values are stored as structured key-value pairs when the secret contains
/// `key: value` lines, or as a single `value` field for plain text secrets.
#[derive(Debug, serde::Serialize)]
struct SecretEntry {
    page: String,
    folder: String,
    label: String,
    /// Structured fields parsed from `Key: Value` lines.
    /// Empty if the secret is not in key-value format.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    fields: BTreeMap<String, String>,
    /// Raw value (only set when the secret is NOT key-value structured).
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<String>,
}

/// A flat row for CSV export (key-value pairs are flattened to a single value column).
struct CsvRow {
    page: String,
    folder: String,
    label: String,
    value: String,
}

/// Export only secrets as CSV or JSON.
///
/// JSON: secrets with `Key: Value` lines are exported as structured objects
///       with a `fields` map instead of a flat string.
/// CSV:  always flat `page,folder,label,value` (value is the raw text).
#[tauri::command]
pub fn export_secrets_only(
    file_path: String,
    format: String,
    state: State<VaultState>,
) -> Result<ExportResult, PageError> {
    let vault_dir = get_vault_dir(&state)?;
    reject_destination_inside_vault(&vault_dir, &file_path)?;
    let master_key = get_master_key(&state)?;

    let mut json_entries: Vec<SecretEntry> = Vec::new();
    let mut csv_rows: Vec<CsvRow> = Vec::new();
    let mut pages_with_secrets = 0usize;

    crud::walk_vault_pages(&vault_dir, |_rel_path, meta, content| {
        let decrypted = if meta.encrypted {
            let body = secret::decrypt_full_body_for_export(&content, &master_key);
            secret::decrypt_secrets_for_export(&body, &master_key).unwrap_or(body)
        } else {
            secret::decrypt_secrets_for_export(&content, &master_key)
                .unwrap_or_else(|_| content.clone())
        };

        let pairs = extract_raw_secret_pairs(&meta.title, &meta.folder, &decrypted);
        if pairs.is_empty() {
            return;
        }
        pages_with_secrets += 1;

        for (page, folder, label, raw_value) in &pairs {
            // CSV always gets the flat value
            csv_rows.push(CsvRow {
                page: page.clone(),
                folder: folder.clone(),
                label: label.clone(),
                value: raw_value.clone(),
            });

            // JSON: try to parse as structured key-value pairs
            let fields = parse_key_value_pairs(raw_value);
            if fields.is_empty() {
                json_entries.push(SecretEntry {
                    page: page.clone(),
                    folder: folder.clone(),
                    label: label.clone(),
                    fields: BTreeMap::new(),
                    value: Some(raw_value.clone()),
                });
            } else {
                json_entries.push(SecretEntry {
                    page: page.clone(),
                    folder: folder.clone(),
                    label: label.clone(),
                    fields,
                    value: None,
                });
            }
        }
    })?;

    let secrets_count = csv_rows.len();

    match format.as_str() {
        "csv" => write_csv(&file_path, &csv_rows)?,
        "json" => write_json(&file_path, &json_entries)?,
        _ => {
            return Err(PageError::InvalidFrontmatter(format!(
                "unknown export format: {format}"
            )))
        }
    }

    Ok(ExportResult {
        pages_exported: pages_with_secrets,
        secrets_exported: secrets_count,
        file_path,
    })
}

/// Extract raw secret label+value tuples from decrypted markdown.
/// Returns (page, folder, label, raw_value).
fn extract_raw_secret_pairs(
    page_title: &str,
    folder: &str,
    content: &str,
) -> Vec<(String, String, String, String)> {
    let mut entries = Vec::new();
    let mut in_code_fence = false;
    let mut in_secret = false;
    let mut current_label = String::new();
    let mut current_value = String::new();

    for line in content.lines() {
        let trimmed = line.trim();

        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_code_fence = !in_code_fence;
            continue;
        }
        if in_code_fence {
            continue;
        }

        if trimmed.starts_with(":::secret[") {
            if let Some(label) = parse_label(trimmed) {
                in_secret = true;
                current_label = label;
                current_value.clear();
            }
            continue;
        }

        if in_secret && trimmed == ":::" {
            let value = current_value.trim().to_string();
            if !value.is_empty() {
                entries.push((
                    page_title.to_string(),
                    folder.to_string(),
                    current_label.clone(),
                    value,
                ));
            }
            in_secret = false;
            continue;
        }

        if in_secret {
            if !current_value.is_empty() {
                current_value.push('\n');
            }
            current_value.push_str(line);
        }
    }

    entries
}

/// Parse `Key: Value` lines into a structured map.
/// Returns empty map if fewer than 1 line matches the pattern.
fn parse_key_value_pairs(raw: &str) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    let mut non_kv_lines = 0;

    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some((key, value)) = trimmed.split_once(':') {
            let key = key.trim();
            let value = value.trim();
            if !key.is_empty() && !key.contains(' ') || is_common_key(key) {
                map.insert(key.to_string(), value.to_string());
                continue;
            }
        }
        non_kv_lines += 1;
    }

    // If most lines aren't key-value, treat the whole thing as raw text
    if non_kv_lines > map.len() {
        return BTreeMap::new();
    }

    map
}

/// Check if a key name (possibly with spaces) is a common credential field.
fn is_common_key(key: &str) -> bool {
    let lower = key.to_lowercase();
    matches!(
        lower.as_str(),
        "url"
            | "username"
            | "password"
            | "email"
            | "api key"
            | "api_key"
            | "token"
            | "secret"
            | "host"
            | "port"
            | "database"
            | "server"
            | "2fa"
            | "2fa backup"
            | "totp"
            | "recovery"
            | "notes"
            | "pin"
            | "account"
            | "name"
            | "phone"
            | "address"
            | "ssh key"
            | "access key"
            | "secret key"
    )
}

/// Parse label from `:::secret[Label]` line.
fn parse_label(line: &str) -> Option<String> {
    let after = line.trim().strip_prefix(":::secret[")?;
    let mut depth = 0i32;
    let chars: Vec<char> = after.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '\\' && i + 1 < chars.len() && chars[i + 1] == ']' {
            i += 2;
            continue;
        }
        match chars[i] {
            '[' => depth += 1,
            ']' if depth == 0 => {
                return Some(after[..i].replace("\\]", "]"));
            }
            ']' => depth -= 1,
            _ => {}
        }
        i += 1;
    }
    None
}

/// Neutralize spreadsheet formula injection (CSV injection): a field that
/// begins with `=`, `+`, `-`, `@`, TAB or CR is interpreted as a formula by
/// Excel/Sheets/LibreOffice and can exfiltrate data or run commands when the
/// exported file is opened. Prefix such fields with a single quote so they are
/// treated as literal text. Since secret values are decrypted into this file,
/// this is applied to every exported field.
fn csv_sanitize(field: &str) -> String {
    if field
        .chars()
        .next()
        .is_some_and(|c| matches!(c, '=' | '+' | '-' | '@' | '\t' | '\r'))
    {
        format!("'{field}")
    } else {
        field.to_string()
    }
}

fn write_csv(file_path: &str, rows: &[CsvRow]) -> Result<(), PageError> {
    // Built in memory rather than written straight to the path: `from_path`
    // creates the file at the process umask, and this file holds every secret in
    // the vault in cleartext.
    let mut wtr = csv::Writer::from_writer(Vec::new());
    wtr.write_record(["page", "folder", "label", "value"])
        .map_err(|e| std::io::Error::other(format!("csv: {e}")))?;
    for row in rows {
        wtr.write_record([
            csv_sanitize(&row.page),
            csv_sanitize(&row.folder),
            csv_sanitize(&row.label),
            csv_sanitize(&row.value),
        ])
        .map_err(|e| std::io::Error::other(format!("csv: {e}")))?;
    }
    wtr.flush()
        .map_err(|e| std::io::Error::other(format!("csv: {e}")))?;
    let bytes = wtr
        .into_inner()
        .map_err(|e| std::io::Error::other(format!("csv: {e}")))?;
    write_export_file(file_path, &bytes)
}

/// Canonicalize a path that may not exist yet.
///
/// Walks up to the nearest ancestor that does exist, canonicalizes that, then
/// re-joins the remaining components. Canonicalizing only the parent is not
/// enough: when the parent is missing too, the fallback returns an
/// uncanonicalized path that will not compare equal to a canonicalized vault
/// root — on macOS, for instance, `/var` resolves to `/private/var`, so the
/// containment check silently passes something it should have refused.
fn canonicalize_lenient(target: &Path) -> std::path::PathBuf {
    if let Ok(p) = target.canonicalize() {
        return p;
    }

    let mut suffix: Vec<std::ffi::OsString> = Vec::new();
    let mut cursor = target.to_path_buf();

    loop {
        match cursor.parent() {
            Some(parent) => {
                if let Some(name) = cursor.file_name() {
                    suffix.push(name.to_os_string());
                }
                cursor = parent.to_path_buf();
            }
            // Reached the root without finding anything that exists.
            None => return target.to_path_buf(),
        }

        if let Ok(base) = cursor.canonicalize() {
            let mut resolved = base;
            for part in suffix.into_iter().rev() {
                resolved = resolved.join(part);
            }
            return resolved;
        }
    }
}

/// Refuse an export destination that sits inside the vault.
///
/// A secrets export is every credential in the vault in cleartext. Writing it
/// into the vault directory would place that file where the git integration
/// stages everything and sync uploads it — turning an export into a plaintext
/// copy of the vault travelling to every device and remote.
///
/// Compares canonical paths so a symlink or a `..` component cannot walk back
/// in. A destination that does not exist yet is resolved through its parent.
fn reject_destination_inside_vault(vault_dir: &Path, file_path: &str) -> Result<(), PageError> {
    let target = Path::new(file_path);
    let resolved = canonicalize_lenient(target);

    let canonical_vault = vault_dir
        .canonicalize()
        .unwrap_or_else(|_| vault_dir.to_path_buf());

    if resolved.starts_with(&canonical_vault) {
        return Err(PageError::Crypto(
            "refusing to export secrets into the vault directory — the file would be \
             committed and synced in cleartext. Choose a location outside the vault."
                .into(),
        ));
    }
    Ok(())
}

/// Write an export file readable only by its owner.
///
/// The contents are every secret in the vault in cleartext, so the default
/// umask — world-readable on a typical system — is not acceptable. Shares
/// `write_restricted` with the vault writers rather than repeating the
/// permission handling.
fn write_export_file(file_path: &str, bytes: &[u8]) -> Result<(), PageError> {
    crate::vault::init::write_restricted(Path::new(file_path), bytes)
        .map_err(|e| PageError::Io(std::io::Error::other(e.to_string())))
}

fn write_json(file_path: &str, entries: &[SecretEntry]) -> Result<(), PageError> {
    let json = serde_json::to_string_pretty(entries)
        .map_err(|e| std::io::Error::other(format!("json: {e}")))?;
    write_export_file(file_path, json.as_bytes())
}

/// Result of importing from a zip archive.
#[derive(Debug, serde::Serialize)]
pub struct ImportZipResult {
    pub imported: usize,
    pub skipped: usize,
    pub errors: Vec<String>,
}

/// Import pages from a Claspt vault export zip file.
///
/// Extracts the zip (with optional AES-256 password), then imports all `.md`
/// files into the vault under a timestamped folder like `imported-20260330`.
/// Secret blocks in the imported files are re-encrypted with the current
/// vault's master key.
#[tauri::command]
pub fn import_from_zip(
    zip_path: String,
    password: Option<String>,
    state: State<VaultState>,
) -> Result<ImportZipResult, PageError> {
    let vault_dir = get_vault_dir(&state)?;
    let master_key = get_master_key(&state)?;

    // Create a temp directory for extraction
    let temp_dir = std::env::temp_dir().join(format!("claspt-import-{}", std::process::id()));
    if temp_dir.exists() {
        std::fs::remove_dir_all(&temp_dir)?;
    }
    std::fs::create_dir_all(&temp_dir)?;

    // Extract zip
    let zip_file = std::fs::File::open(&zip_path)?;
    let mut archive = zip::ZipArchive::new(zip_file).map_err(|e| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, format!("invalid zip: {e}"))
    })?;

    for i in 0..archive.len() {
        let mut file = if let Some(ref pw) = password {
            if !pw.is_empty() {
                archive.by_index_decrypt(i, pw.as_bytes()).map_err(|e| {
                    std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        format!("zip entry error: {e}"),
                    )
                })?
            } else {
                archive.by_index(i).map_err(|e| {
                    std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        format!("zip entry error: {e}"),
                    )
                })?
            }
        } else {
            archive.by_index(i).map_err(|e| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("zip entry error: {e}"),
                )
            })?
        };

        // Use the zip crate's sanitized name accessor to defend against
        // Zip Slip (`../` traversal or absolute paths in entry names). Entries
        // whose name cannot be safely contained are skipped rather than written
        // outside the extraction directory.
        let Some(relative) = file.enclosed_name() else {
            continue;
        };
        let out_path = temp_dir.join(&relative);
        // Defense in depth: reject anything that escaped the temp dir.
        if !out_path.starts_with(&temp_dir) {
            continue;
        }

        // Skip directories and non-.md files
        if file.is_dir() {
            std::fs::create_dir_all(&out_path)?;
            continue;
        }

        // Create parent dirs and extract file
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut out_file = std::fs::File::create(&out_path)?;
        std::io::copy(&mut file, &mut out_file)?;
    }

    // Generate target folder name with today's date
    let today = chrono::Local::now().format("%Y%m%d").to_string();
    let target_folder = format!("imported-{}", today);

    // Use existing import_folder logic
    let result = crate::utilities::import_folder::import_folder(
        &vault_dir,
        &master_key,
        temp_dir.to_str().unwrap_or_default(),
        &target_folder,
    )?;

    // Clean up temp directory
    let _ = std::fs::remove_dir_all(&temp_dir);

    Ok(ImportZipResult {
        imported: result.imported,
        skipped: result.skipped,
        errors: result.errors,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    /// A secrets export is every credential in the vault in cleartext, so the
    /// file must be no more readable than the vault itself. Both writers used
    /// the process umask, which is world-readable on a typical system.
    #[cfg(unix)]
    #[test]
    fn exports_are_written_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempdir().unwrap();

        let csv_path = dir.path().join("secrets.csv");
        write_csv(
            csv_path.to_str().unwrap(),
            &[CsvRow {
                page: "Bank".into(),
                folder: "general".into(),
                label: "Login".into(),
                value: "hunter2".into(),
            }],
        )
        .unwrap();

        let json_path = dir.path().join("secrets.json");
        write_json(json_path.to_str().unwrap(), &[]).unwrap();

        for path in [&csv_path, &json_path] {
            let mode = std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
            assert_eq!(
                mode,
                0o600,
                "{} is mode {mode:o}, readable beyond the owner",
                path.display()
            );
        }

        // The value really is in there — the permission check is meaningless
        // otherwise.
        let csv = std::fs::read_to_string(&csv_path).unwrap();
        assert!(csv.contains("hunter2"));
    }

    /// Exporting into the vault would put a cleartext copy of every secret where
    /// git stages everything and sync uploads it.
    #[test]
    fn export_into_the_vault_is_refused() {
        let dir = tempdir().unwrap();
        let vault = dir.path().join("Claspt");
        std::fs::create_dir_all(vault.join("general")).unwrap();

        for candidate in [
            vault.join("secrets.csv"),
            vault.join("general").join("secrets.csv"),
            vault.join(".securenotes").join("secrets.json"),
        ] {
            assert!(
                reject_destination_inside_vault(&vault, candidate.to_str().unwrap()).is_err(),
                "export to {} should be refused",
                candidate.display()
            );
        }

        // A path that walks back into the vault is refused too.
        let sneaky = vault.join("general").join("..").join("secrets.csv");
        assert!(
            reject_destination_inside_vault(&vault, sneaky.to_str().unwrap()).is_err(),
            "a path resolving back into the vault should be refused"
        );
    }

    /// Somewhere outside the vault is the normal case and must still work.
    #[test]
    fn export_outside_the_vault_is_allowed() {
        let dir = tempdir().unwrap();
        let vault = dir.path().join("Claspt");
        std::fs::create_dir_all(&vault).unwrap();

        let downloads = dir.path().join("Downloads");
        std::fs::create_dir_all(&downloads).unwrap();

        for candidate in [downloads.join("secrets.csv"), dir.path().join("out.json")] {
            reject_destination_inside_vault(&vault, candidate.to_str().unwrap()).unwrap_or_else(
                |e| panic!("export to {} should be allowed: {e}", candidate.display()),
            );
        }
    }
}
