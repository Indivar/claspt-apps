// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Per-format parsers that turn external exports into importable entries.
//!
//! Supports password-manager CSV exports (LastPass, 1Password, RoboForm, and a
//! generic column-mapped CSV), KeePass XML, Claspt's own JSON export, and
//! plain markdown files. Each parser produces [`ImportEntry`] values (title +
//! folder + key/value [`ImportField`]s + notes), which [`entry_to_page_content`]
//! renders into a page containing a `:::secret[...]` block. Titles, field values
//! AND notes all go inside that fence, so everything the source vault protected
//! stays protected once `encrypt_secrets` runs over the page.
//! File sizes are capped per format to avoid loading pathologically large files.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

use super::error::ImportError;

// ── Markdown import ──────────────────────────────────────

/// Parsed metadata from a markdown file's YAML frontmatter, shown in the
/// import preview before the file is committed to the vault.
#[derive(Debug, Clone, Serialize)]
pub struct MarkdownImportPreview {
    /// Page title (frontmatter `title`, else first `#` heading, else filename).
    pub title: String,
    /// Folder to file the page under (frontmatter `folder`, else "general").
    pub suggested_folder: String,
    /// Tags parsed from frontmatter.
    pub tags: Vec<String>,
    /// Whether a YAML frontmatter block was found and parsed.
    pub has_frontmatter: bool,
    /// Whether the body contains `:::secret` blocks (values encrypted on import).
    pub has_secrets: bool,
    /// Whether the body references `_media/` images (not copied on import).
    pub has_media_refs: bool,
    /// Approximate word count of the body (whitespace split).
    pub word_count: usize,
    /// First ~500 characters of the body, for the preview panel.
    pub content_preview: String,
    /// Human-readable warnings surfaced to the user before import.
    pub warnings: Vec<String>,
    /// Whether a page with the same title already exists; set by the command
    /// layer after checking the vault (always `false` from the parser).
    pub duplicate_exists: bool,
}

const MAX_MD_FILE_SIZE: usize = 5 * 1024 * 1024; // 5 MB
const MAX_CSV_FILE_SIZE: usize = 50 * 1024 * 1024; // 50 MB
const MAX_XML_FILE_SIZE: usize = 50 * 1024 * 1024; // 50 MB

/// Check file size against a limit, returning a clear error if exceeded.
fn check_file_size(file_path: &Path, max_size: usize, format: &str) -> Result<(), ImportError> {
    let metadata = std::fs::metadata(file_path)?;
    if metadata.len() as usize > max_size {
        return Err(ImportError::Parse(format!(
            "{} file too large ({:.1} MB). Maximum is {} MB.",
            format,
            metadata.len() as f64 / 1_048_576.0,
            max_size / (1024 * 1024)
        )));
    }
    Ok(())
}

/// Parse a markdown file and extract metadata for preview.
#[allow(clippy::manual_strip)] // explicit slice keeps the CRLF/LF frontmatter branches readable
pub fn parse_markdown_preview(file_path: &Path) -> Result<MarkdownImportPreview, ImportError> {
    // 1. Check extension
    let ext = file_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if ext != "md" && ext != "markdown" {
        return Err(ImportError::Parse(
            "File must have .md or .markdown extension".to_string(),
        ));
    }

    // 2. Check file size
    let metadata = std::fs::metadata(file_path)?;
    if metadata.len() as usize > MAX_MD_FILE_SIZE {
        return Err(ImportError::Parse(format!(
            "File too large ({:.1} MB). Maximum is 5 MB.",
            metadata.len() as f64 / 1_048_576.0
        )));
    }

    // 3. Read as UTF-8 (rejects binary)
    let raw = std::fs::read_to_string(file_path)
        .map_err(|e| ImportError::Parse(format!("Not a valid text file: {}", e)))?;

    // 4. Reject null bytes (additional binary protection)
    if raw.contains('\0') {
        return Err(ImportError::Parse(
            "File contains null bytes — appears to be binary".to_string(),
        ));
    }

    let mut warnings = Vec::new();
    let mut title = String::new();
    let mut tags: Vec<String> = Vec::new();
    let mut suggested_folder = "general".to_string();
    let mut has_frontmatter = false;

    // 5. Detect and parse YAML frontmatter
    let body = if raw.starts_with("---\n") || raw.starts_with("---\r\n") {
        let rest = if raw.starts_with("---\r\n") {
            &raw[5..]
        } else {
            &raw[4..]
        };
        if let Some(end_idx) = rest.find("\n---") {
            has_frontmatter = true;
            let yaml_str = &rest[..end_idx];
            // Advance past the closing ---\n
            let after_close = end_idx + 4; // "\n---"
            let body_start = if rest[after_close..].starts_with('\n') {
                after_close + 1
            } else if rest[after_close..].starts_with("\r\n") {
                after_close + 2
            } else {
                after_close
            };

            // Parse YAML flexibly
            if let Ok(value) = serde_yaml::from_str::<serde_yaml::Value>(yaml_str) {
                if let Some(t) = value.get("title").and_then(|v| v.as_str()) {
                    title = t.to_string();
                }
                if let Some(seq) = value.get("tags").and_then(|v| v.as_sequence()) {
                    tags = seq
                        .iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect();
                }
                if let Some(f) = value.get("folder").and_then(|v| v.as_str()) {
                    if !f.is_empty() {
                        suggested_folder = f.to_string();
                    }
                }
            }

            rest[body_start..].to_string()
        } else {
            raw.clone()
        }
    } else {
        raw.clone()
    };

    // 6. Title fallback: first # heading → filename stem
    if title.is_empty() {
        for line in body.lines() {
            let trimmed = line.trim();
            if let Some(heading) = trimmed.strip_prefix("# ") {
                let heading = heading.trim();
                if !heading.is_empty() {
                    title = heading.to_string();
                    break;
                }
            }
        }
    }
    if title.is_empty() {
        title = file_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("Untitled")
            .to_string();
    }

    // 7. Detect :::secret blocks
    let has_secrets = body.contains(":::secret");
    if has_secrets {
        warnings.push("Contains :::secret blocks — values will be encrypted on import".to_string());
    }

    // 8. Detect _media/ image references
    let has_media_refs = body.contains("(_media/") || body.contains("(<_media/");
    if has_media_refs {
        warnings.push(
            "Contains _media/ image references — media files are not copied during import"
                .to_string(),
        );
    }

    // 9. Word count (simple whitespace split on body)
    let word_count = body.split_whitespace().count();

    // 10. Content preview (first ~500 chars)
    let content_preview: String = body.chars().take(500).collect();

    Ok(MarkdownImportPreview {
        title,
        suggested_folder,
        tags,
        has_frontmatter,
        has_secrets,
        has_media_refs,
        word_count,
        content_preview,
        warnings,
        duplicate_exists: false, // Set by the command layer after checking vault
    })
}

/// Strip YAML frontmatter from markdown content, returning just the body.
#[allow(clippy::manual_strip)] // explicit slice keeps the CRLF/LF frontmatter branches readable
pub fn strip_frontmatter(content: &str) -> String {
    if content.starts_with("---\n") || content.starts_with("---\r\n") {
        let rest = if content.starts_with("---\r\n") {
            &content[5..]
        } else {
            &content[4..]
        };
        if let Some(end_idx) = rest.find("\n---") {
            let after_close = end_idx + 4;
            let body_start = if rest[after_close..].starts_with('\n') {
                after_close + 1
            } else if rest[after_close..].starts_with("\r\n") {
                after_close + 2
            } else {
                after_close
            };
            return rest[body_start..].to_string();
        }
    }
    content.to_string()
}

/// A single imported entry ready to become a page with secret blocks.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportEntry {
    /// Page title.
    pub title: String,
    /// Destination folder (slugified).
    pub folder: String,
    /// Secret fields that become `key: value` lines inside the secret block.
    pub fields: Vec<ImportField>,
    /// Free-form notes rendered as plaintext markdown above the secret block.
    pub notes: String,
}

/// One key/value pair within an [`ImportEntry`]'s secret block.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportField {
    /// Field label (e.g. "Username", "Password", "URL").
    pub key: String,
    /// Field value; encrypted once the page's secret block is saved.
    pub value: String,
}

/// Identifies which source format an import file should be parsed as.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ImportFormat {
    /// LastPass CSV export.
    LastPass,
    /// 1Password CSV export.
    OnePassword,
    /// RoboForm CSV export.
    RoboForm,
    /// KeePass XML export.
    KeePass,
    /// Any CSV, with columns auto-mapped or mapped via `CsvColumnMapping`.
    GenericCsv,
    /// A single markdown file (handled by the preview/markdown path).
    Markdown,
    /// Claspt's own JSON export format.
    ClasptJson,
}

/// Flatten a title into something that can safely sit on the single-line open
/// fence, by collapsing control characters (newlines included) into spaces.
///
/// The API write path (`patch_block`) REJECTS fence-breaking input instead,
/// because its caller can correct the label and retry. An import cannot: the
/// title comes from a foreign export file the user has no way to edit, and
/// refusing the entry would leave the credential behind in whatever it was
/// exported from. A title is display metadata, so normalising it costs nothing
/// — whereas leaving it alone stops `parse_secret_open` matching the block and
/// writes every field to disk in cleartext.
fn normalize_import_label(title: &str) -> String {
    let despaced: String = title
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    despaced.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Sanitize a secret field value to prevent fence injection.
/// Escapes `:::` sequences that could prematurely close the secret block.
fn sanitize_secret_field(value: &str) -> String {
    value.replace(":::", "\\:\\:\\:")
}

/// Convert an ImportEntry into page content with a secret block.
pub fn entry_to_page_content(entry: &ImportEntry) -> String {
    let normalized_title = normalize_import_label(&entry.title);
    let secret_label = if normalized_title.is_empty() {
        "Imported Credentials".to_string()
    } else {
        // Deliberately the same escaper the block writer uses, rather than a
        // second copy — a divergence here is how a value ends up unencrypted.
        crate::pages::secret::escape_label(&normalized_title)
    };

    let mut content = String::new();
    content.push_str(&format!(":::secret[{}]\n", secret_label));
    for field in &entry.fields {
        if !field.value.is_empty() {
            content.push_str(&format!(
                "{}: {}\n",
                sanitize_secret_field(&field.key),
                sanitize_secret_field(&field.value)
            ));
        }
    }

    // Notes go INSIDE the fence. They were previously emitted as markdown above
    // it and so were never encrypted, even though password managers routinely
    // keep recovery codes, PINs and security answers there — all of which were
    // encrypted in the vault the user exported from. `sanitize_secret_field`
    // neutralises any `:::` in the text, so a note line cannot close the block
    // early and push the rest of the page outside it.
    if !entry.notes.trim().is_empty() {
        content.push('\n');
        for line in sanitize_secret_field(&entry.notes).lines() {
            content.push_str(line);
            content.push('\n');
        }
    }

    content.push_str(":::\n");

    content
}

// ── LastPass CSV ──────────────────────────────────────────

/// Parse LastPass CSV export.
///
/// Expected columns: url, username, password, totp, extra, name, grouping, fav
pub fn parse_lastpass(file_path: &Path) -> Result<Vec<ImportEntry>, ImportError> {
    check_file_size(file_path, MAX_CSV_FILE_SIZE, "CSV")?;
    let data = std::fs::read_to_string(file_path)?;
    let mut reader = csv::ReaderBuilder::new()
        .flexible(true)
        .from_reader(data.as_bytes());
    let headers = reader.headers()?.clone();
    let mut entries = Vec::new();

    for result in reader.records() {
        let record = result?;
        let row: HashMap<&str, &str> = headers.iter().zip(record.iter()).collect();

        let title = row.get("name").copied().unwrap_or("").to_string();
        let folder = row
            .get("grouping")
            .copied()
            .unwrap_or("imported")
            .to_string();
        let notes = row.get("extra").copied().unwrap_or("").to_string();

        let mut fields = Vec::new();
        if let Some(url) = row.get("url") {
            if !url.is_empty() && *url != "http://sn" {
                fields.push(ImportField {
                    key: "URL".to_string(),
                    value: url.to_string(),
                });
            }
        }
        if let Some(username) = row.get("username") {
            if !username.is_empty() {
                fields.push(ImportField {
                    key: "Username".to_string(),
                    value: username.to_string(),
                });
            }
        }
        if let Some(password) = row.get("password") {
            if !password.is_empty() {
                fields.push(ImportField {
                    key: "Password".to_string(),
                    value: password.to_string(),
                });
            }
        }
        if let Some(totp) = row.get("totp") {
            if !totp.is_empty() {
                fields.push(ImportField {
                    key: "TOTP".to_string(),
                    value: totp.to_string(),
                });
            }
        }

        if !fields.is_empty() || !notes.is_empty() {
            entries.push(ImportEntry {
                title: if title.is_empty() {
                    "Untitled".to_string()
                } else {
                    title
                },
                folder: sanitize_folder(&folder),
                fields,
                notes,
            });
        }
    }

    Ok(entries)
}

// ── 1Password CSV ────────────────────────────────────────

/// Parse 1Password CSV export.
///
/// Expected columns: Title, URL, Username, Password, Notes, Type
pub fn parse_1password(file_path: &Path) -> Result<Vec<ImportEntry>, ImportError> {
    check_file_size(file_path, MAX_CSV_FILE_SIZE, "CSV")?;
    let data = std::fs::read_to_string(file_path)?;
    let mut reader = csv::ReaderBuilder::new()
        .flexible(true)
        .from_reader(data.as_bytes());
    let headers = reader.headers()?.clone();
    let mut entries = Vec::new();

    for result in reader.records() {
        let record = result?;
        let row: HashMap<&str, &str> = headers.iter().zip(record.iter()).collect();

        let title = row.get("Title").copied().unwrap_or("Untitled").to_string();
        let notes = row.get("Notes").copied().unwrap_or("").to_string();

        let mut fields = Vec::new();
        if let Some(url) = row.get("URL") {
            if !url.is_empty() {
                fields.push(ImportField {
                    key: "URL".to_string(),
                    value: url.to_string(),
                });
            }
        }
        if let Some(username) = row.get("Username") {
            if !username.is_empty() {
                fields.push(ImportField {
                    key: "Username".to_string(),
                    value: username.to_string(),
                });
            }
        }
        if let Some(password) = row.get("Password") {
            if !password.is_empty() {
                fields.push(ImportField {
                    key: "Password".to_string(),
                    value: password.to_string(),
                });
            }
        }

        if !fields.is_empty() || !notes.is_empty() {
            entries.push(ImportEntry {
                title,
                folder: "imported".to_string(),
                fields,
                notes,
            });
        }
    }

    Ok(entries)
}

// ── RoboForm CSV ─────────────────────────────────────────

/// Parse RoboForm CSV export.
///
/// Expected columns: Name, Url, MatchUrl, Login, Pwd, Note, Folder
pub fn parse_roboform(file_path: &Path) -> Result<Vec<ImportEntry>, ImportError> {
    check_file_size(file_path, MAX_CSV_FILE_SIZE, "CSV")?;
    let data = std::fs::read_to_string(file_path)?;
    let mut reader = csv::ReaderBuilder::new()
        .flexible(true)
        .from_reader(data.as_bytes());
    let headers = reader.headers()?.clone();
    let mut entries = Vec::new();

    for result in reader.records() {
        let record = result?;
        let row: HashMap<&str, &str> = headers.iter().zip(record.iter()).collect();

        let title = row.get("Name").copied().unwrap_or("Untitled").to_string();
        let folder = row.get("Folder").copied().unwrap_or("imported").to_string();
        let notes = row.get("Note").copied().unwrap_or("").to_string();

        let mut fields = Vec::new();
        if let Some(url) = row.get("Url") {
            if !url.is_empty() {
                fields.push(ImportField {
                    key: "URL".to_string(),
                    value: url.to_string(),
                });
            }
        }
        if let Some(login) = row.get("Login") {
            if !login.is_empty() {
                fields.push(ImportField {
                    key: "Login".to_string(),
                    value: login.to_string(),
                });
            }
        }
        if let Some(pwd) = row.get("Pwd") {
            if !pwd.is_empty() {
                fields.push(ImportField {
                    key: "Password".to_string(),
                    value: pwd.to_string(),
                });
            }
        }

        if !fields.is_empty() || !notes.is_empty() {
            entries.push(ImportEntry {
                title,
                folder: sanitize_folder(&folder),
                fields,
                notes,
            });
        }
    }

    Ok(entries)
}

// ── KeePass XML ──────────────────────────────────────────

/// Parse KeePass XML export.
pub fn parse_keepass(file_path: &Path) -> Result<Vec<ImportEntry>, ImportError> {
    check_file_size(file_path, MAX_XML_FILE_SIZE, "XML")?;
    let data = std::fs::read_to_string(file_path)?;
    let mut entries = Vec::new();
    parse_keepass_xml(&data, "imported", &mut entries)?;
    Ok(entries)
}

/// KeePass 2 XML export.
///
/// This was a line scanner that matched `<Value>` and `</Value>` on one line.
/// KeePass writes the password as `<Value ProtectInMemory="True">`, which the
/// scanner never matched, so every imported login arrived without its
/// password; a multi-line Notes field lost every line but the first; `&amp;`
/// stayed `&amp;`; and the old versions KeePass keeps under `<History>` were
/// imported as if they were current. It is parsed as XML now.
fn parse_keepass_xml(
    xml: &str,
    _default_folder: &str,
    entries: &mut Vec<ImportEntry>,
) -> Result<(), ImportError> {
    use quick_xml::events::Event;
    use quick_xml::Reader;

    let mut reader = Reader::from_str(xml);
    let mut path: Vec<String> = Vec::new();
    let mut groups: Vec<String> = Vec::new();
    let mut history_depth = 0usize;
    let mut in_entry = false;
    let mut entry_fields: Vec<(String, String)> = Vec::new();
    let mut key = String::new();
    let mut value = String::new();
    let mut text = String::new();

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                let name = e.name().as_ref().to_owned();
                match name.as_str() {
                    "History" => history_depth += 1,
                    "Group" if history_depth == 0 => groups.push(String::new()),
                    "Entry" if history_depth == 0 => {
                        in_entry = true;
                        entry_fields.clear();
                    }
                    "String" if in_entry && history_depth == 0 => {
                        key.clear();
                        value.clear();
                    }
                    _ => {}
                }
                path.push(name);
                text.clear();
            }
            Ok(Event::Empty(e)) => {
                // `<Value/>`: an empty field, which is still a field.
                let name = e.name().as_ref().to_owned();
                if in_entry && history_depth == 0 && name == "Value" {
                    value.clear();
                }
            }
            Ok(Event::Text(t)) => {
                // quick-xml 0.38+ resolves character and predefined entity
                // references while reading, so the text arrives unescaped;
                // `xml_content` decodes it and normalises line ends. KeePass
                // writes XML 1.0 and declares it.
                text.push_str(&t.xml_content(quick_xml::XmlVersion::Explicit1_0));
            }
            Ok(Event::GeneralRef(r)) => {
                // quick-xml 0.41 hands every reference back as an event rather
                // than expanding it in the text. Character references and the
                // five predefined entities are what a KeePass export contains
                // (`&amp;` in a password, `&lt;` in a note); anything else is
                // kept as written rather than dropped.
                if let Some(c) = r
                    .resolve_char_ref()
                    .map_err(|e| ImportError::from(quick_xml::DeError::from(e)))?
                {
                    text.push(c);
                    continue;
                }
                let name = r.into_inner();
                match name.as_ref() {
                    "amp" => text.push('&'),
                    "lt" => text.push('<'),
                    "gt" => text.push('>'),
                    "quot" => text.push('"'),
                    "apos" => text.push('\''),
                    other => {
                        text.push('&');
                        text.push_str(other);
                        text.push(';');
                    }
                }
            }
            Ok(Event::CData(c)) => {
                text.push_str(&c.into_inner());
            }
            Ok(Event::End(e)) => {
                let name = e.name().as_ref().to_owned();
                let parent = path
                    .len()
                    .checked_sub(2)
                    .and_then(|i| path.get(i))
                    .cloned()
                    .unwrap_or_default();
                match name.as_str() {
                    "History" => history_depth = history_depth.saturating_sub(1),
                    "Name" if parent == "Group" && history_depth == 0 && !in_entry => {
                        if let Some(group) = groups.last_mut() {
                            *group = text.trim().to_string();
                        }
                    }
                    "Key" if in_entry && history_depth == 0 && parent == "String" => {
                        key = text.clone()
                    }
                    "Value" if in_entry && history_depth == 0 && parent == "String" => {
                        value = text.clone()
                    }
                    "String" if in_entry && history_depth == 0 => {
                        entry_fields.push((key.clone(), value.clone()))
                    }
                    "Entry" if in_entry && history_depth == 0 => {
                        in_entry = false;
                        if !groups.iter().any(|g| g == "Recycle Bin") {
                            push_keepass_entry(&entry_fields, &keepass_folder(&groups), entries);
                        }
                    }
                    "Group" if history_depth == 0 => {
                        groups.pop();
                    }
                    _ => {}
                }
                path.pop();
                text.clear();
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(ImportError::from(quick_xml::DeError::from(e))),
            _ => {}
        }
    }
    Ok(())
}

/// The innermost named group, as a folder; "Root" is KeePass's own name for
/// the top and says nothing about the entry.
fn keepass_folder(groups: &[String]) -> String {
    groups
        .iter()
        .rev()
        .find(|g| !g.is_empty() && *g != "Root")
        .map(|g| sanitize_folder(g))
        .unwrap_or_else(|| "imported".to_string())
}

fn push_keepass_entry(
    entry_fields: &[(String, String)],
    folder: &str,
    entries: &mut Vec<ImportEntry>,
) {
    let mut title = String::new();
    let mut notes = String::new();
    let mut fields = Vec::new();

    for (key, value) in entry_fields {
        match key.as_str() {
            "Title" => title = value.clone(),
            "Notes" => notes = value.clone(),
            "URL" | "UserName" | "Password" => {
                if !value.is_empty() {
                    let display_key = match key.as_str() {
                        "UserName" => "Username",
                        k => k,
                    };
                    fields.push(ImportField {
                        key: display_key.to_string(),
                        value: value.clone(),
                    });
                }
            }
            _ => {
                if !value.is_empty() {
                    fields.push(ImportField {
                        key: key.clone(),
                        value: value.clone(),
                    });
                }
            }
        }
    }

    if !fields.is_empty() || !notes.is_empty() {
        entries.push(ImportEntry {
            title: if title.is_empty() {
                "Untitled".to_string()
            } else {
                title
            },
            folder: folder.to_string(),
            fields,
            notes,
        });
    }
}

/// Clean up folder names from imports.
fn sanitize_folder(folder: &str) -> String {
    let cleaned = folder.replace('\\', "/").trim_matches('/').to_string();
    if cleaned.is_empty() {
        "imported".to_string()
    } else {
        slug::slugify(&cleaned)
    }
}

// ── Generic CSV ──────────────────────────────────────────

/// A user-visible column mapping: header name paired with its assigned role.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CsvColumnMapping {
    pub header: String,
    /// One of: "title", "username", "password", "email", "url", "otp", "notes", "folder", "field", "skip"
    pub role: String,
}

/// Column role classification for generic CSV auto-mapping.
#[derive(Debug, Clone, PartialEq)]
enum CsvColumnRole {
    Title,
    Username,
    Password,
    Email,
    Url,
    Otp,
    Notes,
    Folder,
    Skip,
    /// Unrecognized header — becomes a field with the original header name.
    Other(String),
}

/// Classify a CSV header into a column role using case-insensitive matching.
fn classify_csv_header(header: &str) -> CsvColumnRole {
    let h = header.trim().to_lowercase();
    match h.as_str() {
        "title" | "name" | "entry" | "account" => CsvColumnRole::Title,
        "username" | "user" | "login" => CsvColumnRole::Username,
        "password" | "pass" | "pwd" => CsvColumnRole::Password,
        "email" | "e-mail" => CsvColumnRole::Email,
        "url" | "website" | "site" => CsvColumnRole::Url,
        "otpauth" | "otp" | "totp" | "2fa" => CsvColumnRole::Otp,
        "notes" | "note" | "comment" | "comments" | "description" | "extra" => CsvColumnRole::Notes,
        "folder" | "group" | "grouping" | "category" | "type" => CsvColumnRole::Folder,
        _ => CsvColumnRole::Other(header.trim().to_string()),
    }
}

fn role_to_string(role: &CsvColumnRole) -> String {
    match role {
        CsvColumnRole::Title => "title".to_string(),
        CsvColumnRole::Username => "username".to_string(),
        CsvColumnRole::Password => "password".to_string(),
        CsvColumnRole::Email => "email".to_string(),
        CsvColumnRole::Url => "url".to_string(),
        CsvColumnRole::Otp => "otp".to_string(),
        CsvColumnRole::Notes => "notes".to_string(),
        CsvColumnRole::Folder => "folder".to_string(),
        CsvColumnRole::Skip => "skip".to_string(),
        CsvColumnRole::Other(_) => "field".to_string(),
    }
}

fn string_to_role(role: &str, header: &str) -> CsvColumnRole {
    match role {
        "title" => CsvColumnRole::Title,
        "username" => CsvColumnRole::Username,
        "password" => CsvColumnRole::Password,
        "email" => CsvColumnRole::Email,
        "url" => CsvColumnRole::Url,
        "otp" => CsvColumnRole::Otp,
        "notes" => CsvColumnRole::Notes,
        "folder" => CsvColumnRole::Folder,
        "skip" => CsvColumnRole::Skip,
        _ => CsvColumnRole::Other(header.to_string()),
    }
}

/// Read CSV headers and return auto-detected column mappings.
pub fn detect_csv_columns(file_path: &Path) -> Result<Vec<CsvColumnMapping>, ImportError> {
    check_file_size(file_path, MAX_CSV_FILE_SIZE, "CSV")?;
    let data = std::fs::read_to_string(file_path)?;
    let mut reader = csv::ReaderBuilder::new()
        .flexible(true)
        .from_reader(data.as_bytes());
    let headers = reader.headers()?.clone();

    Ok(headers
        .iter()
        .map(|h| {
            let role = classify_csv_header(h);
            CsvColumnMapping {
                header: h.trim().to_string(),
                role: role_to_string(&role),
            }
        })
        .collect())
}

/// Parse a generic CSV file by auto-mapping headers to known roles.
pub fn parse_generic_csv(file_path: &Path) -> Result<Vec<ImportEntry>, ImportError> {
    check_file_size(file_path, MAX_CSV_FILE_SIZE, "CSV")?;
    let data = std::fs::read_to_string(file_path)?;
    parse_generic_csv_inner(&data, None)
}

/// Parse a generic CSV file using user-provided column mappings.
pub fn parse_generic_csv_with_mappings(
    file_path: &Path,
    mappings: &[CsvColumnMapping],
) -> Result<Vec<ImportEntry>, ImportError> {
    check_file_size(file_path, MAX_CSV_FILE_SIZE, "CSV")?;
    let data = std::fs::read_to_string(file_path)?;
    parse_generic_csv_inner(&data, Some(mappings))
}

fn parse_generic_csv_inner(
    data: &str,
    custom_mappings: Option<&[CsvColumnMapping]>,
) -> Result<Vec<ImportEntry>, ImportError> {
    let mut reader = csv::ReaderBuilder::new()
        .flexible(true)
        .from_reader(data.as_bytes());
    let headers = reader.headers()?.clone();

    // Build roles from custom mappings or auto-detect
    let roles: Vec<CsvColumnRole> = if let Some(mappings) = custom_mappings {
        headers
            .iter()
            .enumerate()
            .map(|(i, h)| {
                if let Some(m) = mappings.get(i) {
                    string_to_role(&m.role, &m.header)
                } else {
                    classify_csv_header(h)
                }
            })
            .collect()
    } else {
        headers.iter().map(classify_csv_header).collect()
    };

    let mut entries = Vec::new();

    for result in reader.records() {
        let record = result?;

        let mut title = String::new();
        let mut folder = String::new();
        let mut notes = String::new();
        let mut fields = Vec::new();

        for (i, value) in record.iter().enumerate() {
            if value.is_empty() {
                continue;
            }
            let Some(role) = roles.get(i) else { continue };
            match role {
                CsvColumnRole::Title => {
                    if title.is_empty() {
                        title = value.to_string();
                    }
                }
                CsvColumnRole::Notes => {
                    if notes.is_empty() {
                        notes = value.to_string();
                    }
                }
                CsvColumnRole::Folder => {
                    if folder.is_empty() {
                        folder = value.to_string();
                    }
                }
                CsvColumnRole::Username => {
                    fields.push(ImportField {
                        key: "Username".to_string(),
                        value: value.to_string(),
                    });
                }
                CsvColumnRole::Password => {
                    fields.push(ImportField {
                        key: "Password".to_string(),
                        value: value.to_string(),
                    });
                }
                CsvColumnRole::Email => {
                    fields.push(ImportField {
                        key: "Email".to_string(),
                        value: value.to_string(),
                    });
                }
                CsvColumnRole::Url => {
                    fields.push(ImportField {
                        key: "URL".to_string(),
                        value: value.to_string(),
                    });
                }
                CsvColumnRole::Otp => {
                    fields.push(ImportField {
                        key: "OTP".to_string(),
                        value: value.to_string(),
                    });
                }
                CsvColumnRole::Skip => {}
                CsvColumnRole::Other(header_name) => {
                    fields.push(ImportField {
                        key: header_name.clone(),
                        value: value.to_string(),
                    });
                }
            }
        }

        if !fields.is_empty() || !notes.is_empty() {
            entries.push(ImportEntry {
                title: if title.is_empty() {
                    "Untitled".to_string()
                } else {
                    title
                },
                folder: sanitize_folder(if folder.is_empty() {
                    "imported"
                } else {
                    &folder
                }),
                fields,
                notes,
            });
        }
    }

    Ok(entries)
}

/// Parse any supported format by file extension or explicit format.
/// For `GenericCsv`, pass `column_mappings` to override auto-detected roles.
pub fn parse_import(
    file_path: &Path,
    format: &ImportFormat,
    column_mappings: Option<&[CsvColumnMapping]>,
) -> Result<Vec<ImportEntry>, ImportError> {
    match format {
        ImportFormat::LastPass => parse_lastpass(file_path),
        ImportFormat::OnePassword => parse_1password(file_path),
        ImportFormat::RoboForm => parse_roboform(file_path),
        ImportFormat::KeePass => parse_keepass(file_path),
        ImportFormat::GenericCsv => match column_mappings {
            Some(mappings) => parse_generic_csv_with_mappings(file_path, mappings),
            None => parse_generic_csv(file_path),
        },
        ImportFormat::Markdown => Ok(Vec::new()),
        ImportFormat::ClasptJson => parse_claspt_json(file_path),
    }
}

/// Parse Claspt JSON export format.
///
/// Handles both structured secrets (with `fields` map) and flat secrets (with `value` string).
/// Format:
/// ```json
/// [
///   { "page": "Title", "folder": "general", "label": "Secret Label",
///     "fields": { "URL": "...", "Username": "..." } },
///   { "page": "Title", "folder": "general", "label": "Secret Label",
///     "value": "raw text value" }
/// ]
/// ```
#[allow(clippy::type_complexity)] // local grouping map; a named alias would not aid readability here
fn parse_claspt_json(file_path: &Path) -> Result<Vec<ImportEntry>, ImportError> {
    let raw = std::fs::read_to_string(file_path)
        .map_err(|e| ImportError::Parse(format!("failed to read JSON: {e}")))?;

    let items: Vec<serde_json::Value> =
        serde_json::from_str(&raw).map_err(|e| ImportError::Parse(format!("invalid JSON: {e}")))?;

    // Group secrets by (page, folder) so multiple secrets on the same page become one ImportEntry
    let mut page_map: std::collections::BTreeMap<
        (String, String),
        Vec<(String, Vec<ImportField>)>,
    > = std::collections::BTreeMap::new();

    for item in &items {
        let page = item
            .get("page")
            .and_then(|v| v.as_str())
            .unwrap_or("Untitled")
            .to_string();
        let folder = item
            .get("folder")
            .and_then(|v| v.as_str())
            .unwrap_or("imported")
            .to_string();
        let label = item
            .get("label")
            .and_then(|v| v.as_str())
            .unwrap_or("Secret")
            .to_string();

        let fields: Vec<ImportField> =
            if let Some(fields_obj) = item.get("fields").and_then(|v| v.as_object()) {
                // Structured: { "URL": "...", "Username": "..." }
                fields_obj
                    .iter()
                    .map(|(k, v)| ImportField {
                        key: k.clone(),
                        value: v.as_str().unwrap_or_default().to_string(),
                    })
                    .collect()
            } else if let Some(value) = item.get("value").and_then(|v| v.as_str()) {
                // Flat value — try to parse as Key: Value lines
                let mut parsed = Vec::new();
                for line in value.lines() {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    if let Some((key, val)) = trimmed.split_once(':') {
                        let key = key.trim();
                        let val = val.trim();
                        if !key.is_empty() {
                            parsed.push(ImportField {
                                key: key.to_string(),
                                value: val.to_string(),
                            });
                            continue;
                        }
                    }
                    // Not a key-value line — store as "Value"
                    parsed.push(ImportField {
                        key: "Value".to_string(),
                        value: trimmed.to_string(),
                    });
                }
                parsed
            } else {
                vec![]
            };

        page_map
            .entry((page, sanitize_folder(&folder)))
            .or_default()
            .push((label, fields));
    }

    // Convert grouped entries into ImportEntry objects
    let entries: Vec<ImportEntry> = page_map
        .into_iter()
        .map(|((page, folder), secrets)| {
            // If there's only one secret, use the label as the page title might already match
            let all_fields: Vec<ImportField> = secrets
                .into_iter()
                .flat_map(|(_label, fields)| fields)
                .collect();

            ImportEntry {
                title: page,
                folder,
                fields: all_fields,
                notes: String::new(),
            }
        })
        .collect();

    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn lastpass_csv_parse() {
        let csv = "url,username,password,totp,extra,name,grouping,fav\n\
                    https://example.com,user@test.com,secret123,,some notes,Example Login,Social,0\n\
                    http://sn,,,,,Secure Note,Notes,0\n";
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("lastpass.csv");
        std::fs::write(&path, csv).unwrap();

        let entries = parse_lastpass(&path).unwrap();
        assert_eq!(entries.len(), 1); // Secure Note with no fields/notes filtered out
        assert_eq!(entries[0].title, "Example Login");
        assert_eq!(entries[0].fields.len(), 3); // URL, Username, Password
        assert_eq!(entries[0].notes, "some notes");
    }

    #[test]
    fn onepassword_csv_parse() {
        let csv = "Title,URL,Username,Password,Notes,Type\n\
                    My Login,https://site.com,admin,pass123,important note,Login\n";
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("1password.csv");
        std::fs::write(&path, csv).unwrap();

        let entries = parse_1password(&path).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].title, "My Login");
        assert_eq!(entries[0].fields.len(), 3);
    }

    #[test]
    fn roboform_csv_parse() {
        let csv = "Name,Url,MatchUrl,Login,Pwd,Note,Folder\n\
                    Test Site,https://test.com,,testuser,pass456,,Web\n";
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("roboform.csv");
        std::fs::write(&path, csv).unwrap();

        let entries = parse_roboform(&path).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].title, "Test Site");
        assert_eq!(entries[0].fields.len(), 3);
    }

    #[test]
    fn keepass_xml_parse() {
        let xml = r#"<?xml version="1.0" encoding="utf-8"?>
<KeePassFile>
    <Root>
        <Group>
            <Name>Root</Name>
            <Group>
                <Name>Internet</Name>
                <Entry>
                    <String>
                        <Key>Title</Key>
                        <Value>Gmail</Value>
                    </String>
                    <String>
                        <Key>UserName</Key>
                        <Value>user@gmail.com</Value>
                    </String>
                    <String>
                        <Key>Password</Key>
                        <Value>gmail_pass</Value>
                    </String>
                    <String>
                        <Key>URL</Key>
                        <Value>https://mail.google.com</Value>
                    </String>
                    <String>
                        <Key>Notes</Key>
                        <Value>Main email account</Value>
                    </String>
                </Entry>
            </Group>
        </Group>
    </Root>
</KeePassFile>"#;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("keepass.xml");
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(xml.as_bytes()).unwrap();

        let entries = parse_keepass(&path).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].title, "Gmail");
        assert_eq!(entries[0].folder, "internet");
        assert!(entries[0]
            .fields
            .iter()
            .any(|f| f.key == "Username" && f.value == "user@gmail.com"));
        assert_eq!(entries[0].notes, "Main email account");
    }

    #[test]
    fn generic_csv_parse() {
        let csv = "Title,Username,Email,Password,URL,OTPAuth,Notes\n\
                    Gmail,user@gmail.com,user@gmail.com,secret123,https://gmail.com,otpauth://totp/Gmail,Main account\n\
                    GitHub,octocat,,gh_pass,https://github.com,,\n";
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("keepass.csv");
        std::fs::write(&path, csv).unwrap();

        let entries = parse_generic_csv(&path).unwrap();
        assert_eq!(entries.len(), 2);

        // First entry: all fields populated
        assert_eq!(entries[0].title, "Gmail");
        assert_eq!(entries[0].notes, "Main account");
        assert_eq!(entries[0].folder, "imported");
        assert!(entries[0]
            .fields
            .iter()
            .any(|f| f.key == "Username" && f.value == "user@gmail.com"));
        assert!(entries[0]
            .fields
            .iter()
            .any(|f| f.key == "Email" && f.value == "user@gmail.com"));
        assert!(entries[0]
            .fields
            .iter()
            .any(|f| f.key == "Password" && f.value == "secret123"));
        assert!(entries[0]
            .fields
            .iter()
            .any(|f| f.key == "URL" && f.value == "https://gmail.com"));
        assert!(entries[0]
            .fields
            .iter()
            .any(|f| f.key == "OTP" && f.value == "otpauth://totp/Gmail"));

        // Second entry: sparse fields
        assert_eq!(entries[1].title, "GitHub");
        assert!(entries[1].notes.is_empty());
        assert_eq!(entries[1].fields.len(), 3); // Username, Password, URL
    }

    #[test]
    fn generic_csv_case_insensitive_headers() {
        let csv = "NAME,user,PWD,WEBSITE,Group\n\
                    Test,admin,pass,https://test.com,Web Apps\n";
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("export.csv");
        std::fs::write(&path, csv).unwrap();

        let entries = parse_generic_csv(&path).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].title, "Test");
        assert_eq!(entries[0].folder, "web-apps");
        assert!(entries[0].fields.iter().any(|f| f.key == "Username"));
        assert!(entries[0].fields.iter().any(|f| f.key == "Password"));
        assert!(entries[0].fields.iter().any(|f| f.key == "URL"));
    }

    #[test]
    fn generic_csv_unknown_columns_become_fields() {
        let csv = "Title,Password,Serial Number,License Key\n\
                    Photoshop,,,XXXX-YYYY-ZZZZ\n";
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("software.csv");
        std::fs::write(&path, csv).unwrap();

        let entries = parse_generic_csv(&path).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].title, "Photoshop");
        assert!(entries[0]
            .fields
            .iter()
            .any(|f| f.key == "License Key" && f.value == "XXXX-YYYY-ZZZZ"));
    }

    #[test]
    fn generic_csv_custom_mappings() {
        let csv = "Title,Username,Email,Password,URL,OTPAuth,Notes\n\
                    Gmail,user@gmail.com,user@gmail.com,secret,https://gmail.com,,Main\n";
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("custom.csv");
        std::fs::write(&path, csv).unwrap();

        // Remap: skip Email, treat OTPAuth as a generic field
        let mappings = vec![
            CsvColumnMapping {
                header: "Title".to_string(),
                role: "title".to_string(),
            },
            CsvColumnMapping {
                header: "Username".to_string(),
                role: "username".to_string(),
            },
            CsvColumnMapping {
                header: "Email".to_string(),
                role: "skip".to_string(),
            },
            CsvColumnMapping {
                header: "Password".to_string(),
                role: "password".to_string(),
            },
            CsvColumnMapping {
                header: "URL".to_string(),
                role: "url".to_string(),
            },
            CsvColumnMapping {
                header: "OTPAuth".to_string(),
                role: "field".to_string(),
            },
            CsvColumnMapping {
                header: "Notes".to_string(),
                role: "notes".to_string(),
            },
        ];

        let entries = parse_generic_csv_with_mappings(&path, &mappings).unwrap();
        assert_eq!(entries.len(), 1);
        // Email should be skipped
        assert!(!entries[0].fields.iter().any(|f| f.key == "Email"));
        // OTPAuth should be a generic field with header name
        assert!(!entries[0].fields.iter().any(|f| f.key == "OTP"));
        // Username/Password/URL should be present
        assert_eq!(entries[0].fields.len(), 3); // Username, Password, URL
    }

    #[test]
    fn generic_csv_detect_columns() {
        let csv = "Title,user,PWD,WEBSITE,Extra Column\nrow\n";
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("detect.csv");
        std::fs::write(&path, csv).unwrap();

        let mappings = detect_csv_columns(&path).unwrap();
        assert_eq!(mappings.len(), 5);
        assert_eq!(mappings[0].role, "title");
        assert_eq!(mappings[1].role, "username");
        assert_eq!(mappings[2].role, "password");
        assert_eq!(mappings[3].role, "url");
        assert_eq!(mappings[4].role, "field"); // unknown → field
        assert_eq!(mappings[4].header, "Extra Column");
    }

    #[test]
    fn entry_to_page_content_creates_secret_block() {
        let entry = ImportEntry {
            title: "Test".to_string(),
            folder: "general".to_string(),
            fields: vec![
                ImportField {
                    key: "Username".to_string(),
                    value: "admin".to_string(),
                },
                ImportField {
                    key: "Password".to_string(),
                    value: "secret".to_string(),
                },
            ],
            notes: "Some notes".to_string(),
        };

        let content = entry_to_page_content(&entry);
        assert!(content.contains(":::secret[Test]"));
        assert!(content.contains("Username: admin"));
        assert!(content.contains("Password: secret"));
        assert!(content.contains(":::\n"));
        assert!(content.contains("Some notes"));
    }

    // ── Markdown import tests ─────────────────────────────

    #[test]
    fn markdown_parse_with_frontmatter() {
        let md = "---\ntitle: My Note\ntags:\n  - rust\n  - dev\nfolder: projects\n---\n# Heading\n\nSome content here with words.\n";
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        std::fs::write(&path, md).unwrap();

        let preview = parse_markdown_preview(&path).unwrap();
        assert_eq!(preview.title, "My Note");
        assert_eq!(preview.suggested_folder, "projects");
        assert_eq!(preview.tags, vec!["rust", "dev"]);
        assert!(preview.has_frontmatter);
        assert!(!preview.has_secrets);
        assert!(!preview.has_media_refs);
        assert!(preview.word_count > 0);
        assert!(preview.warnings.is_empty());
    }

    #[test]
    fn markdown_parse_title_from_heading() {
        let md = "# My Heading Title\n\nBody text goes here.\n";
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.md");
        std::fs::write(&path, md).unwrap();

        let preview = parse_markdown_preview(&path).unwrap();
        assert_eq!(preview.title, "My Heading Title");
        assert!(!preview.has_frontmatter);
        assert_eq!(preview.suggested_folder, "general");
    }

    #[test]
    fn markdown_parse_title_from_filename() {
        let md = "Just some text with no heading.\n";
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("my-cool-note.md");
        std::fs::write(&path, md).unwrap();

        let preview = parse_markdown_preview(&path).unwrap();
        assert_eq!(preview.title, "my-cool-note");
    }

    #[test]
    fn markdown_reject_binary_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("binary.md");
        std::fs::write(&path, b"\x00\x01\x02binary\x00data").unwrap();

        let result = parse_markdown_preview(&path);
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("null bytes") || err.contains("valid text"));
    }

    #[test]
    fn markdown_reject_oversized_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("huge.md");
        // Create a file just over 5 MB
        let data = "x".repeat(MAX_MD_FILE_SIZE + 1);
        std::fs::write(&path, data).unwrap();

        let result = parse_markdown_preview(&path);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("too large"));
    }

    #[test]
    fn markdown_detects_secrets_and_media() {
        let md = "# Note\n\n:::secret[API Key]\nkey: abc123\n:::\n\n![photo](_media/pic.png)\n";
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secrets.md");
        std::fs::write(&path, md).unwrap();

        let preview = parse_markdown_preview(&path).unwrap();
        assert!(preview.has_secrets);
        assert!(preview.has_media_refs);
        assert_eq!(preview.warnings.len(), 2);
    }

    #[test]
    fn strip_frontmatter_removes_yaml() {
        let md = "---\ntitle: Test\n---\n# Body\n\nContent\n";
        let body = strip_frontmatter(md);
        assert!(body.starts_with("# Body"));
        assert!(!body.contains("---"));
    }

    #[test]
    fn strip_frontmatter_noop_without_yaml() {
        let md = "# No frontmatter\n\nJust content.\n";
        let body = strip_frontmatter(md);
        assert_eq!(body, md);
    }

    /// Notes imported from another password manager must be encrypted.
    ///
    /// They were written as markdown ABOVE the secret block, so they never
    /// reached the encryptor. Password managers routinely hold recovery codes,
    /// PINs and security answers in the notes field — all of which were
    /// encrypted in the source vault. Emitting them as plaintext is a silent
    /// downgrade of protection the user never asked for.
    #[test]
    fn imported_notes_are_inside_the_encrypted_fence() {
        let entry = ImportEntry {
            title: "Bank".to_string(),
            folder: "general".to_string(),
            fields: vec![ImportField {
                key: "password".to_string(),
                value: "hunter2".to_string(),
            }],
            notes: "recovery code 4821-9930".to_string(),
        };

        let content = entry_to_page_content(&entry);
        let key = crate::crypto::aead::generate_master_key().unwrap().to_vec();
        let encrypted = crate::pages::secret::encrypt_secrets(&content, &key).unwrap();

        assert!(
            !encrypted.contains("4821-9930"),
            "imported note written to disk in plaintext:\n{encrypted}"
        );
        assert!(
            !encrypted.contains("hunter2"),
            "imported password written to disk in plaintext:\n{encrypted}"
        );

        let decrypted = crate::pages::secret::decrypt_secrets(&encrypted, &key).unwrap();
        assert!(
            decrypted.contains("4821-9930"),
            "the note did not survive the round trip:\n{decrypted}"
        );
    }

    /// A title is attacker- or export-controlled text. If it breaks the open
    /// fence, `encrypt_secrets` stops recognising the block and writes every
    /// field to disk in cleartext — so a title must never be able to do that.
    #[test]
    fn hostile_titles_cannot_force_fields_into_plaintext() {
        let key = crate::crypto::aead::generate_master_key().unwrap().to_vec();

        for title in [
            "trailing backslash \\",
            "newline\ninjected",
            "carriage\r\nreturn",
            "bracket] escape",
            "close\n:::\nfence",
            "\\",
        ] {
            let entry = ImportEntry {
                title: title.to_string(),
                folder: "general".to_string(),
                fields: vec![ImportField {
                    key: "password".to_string(),
                    value: "leaky-value-xyz".to_string(),
                }],
                notes: String::new(),
            };

            let content = entry_to_page_content(&entry);
            let encrypted = crate::pages::secret::encrypt_secrets(&content, &key).unwrap();
            assert!(
                !encrypted.contains("leaky-value-xyz"),
                "title {title:?} forced the password onto disk in plaintext:\n{encrypted}"
            );
        }
    }

    #[test]
    fn keepass_xml_is_parsed_as_xml() {
        let xml = r#"<?xml version="1.0" encoding="utf-8"?>
<KeePassFile><Root><Group><Name>Root</Name>
  <Group><Name>Work</Name>
    <Entry>
      <String><Key>Title</Key><Value>Mail</Value></String>
      <String><Key>UserName</Key><Value>me@example.com</Value></String>
      <String><Key>Password</Key><Value ProtectInMemory="True">p&amp;ss&lt;1&gt;</Value></String>
      <String><Key>URL</Key><Value/></String>
      <String><Key>Notes</Key><Value>recovery codes:
1111-2222
3333-4444</Value></String>
      <History>
        <Entry>
          <String><Key>Title</Key><Value>Mail (old)</Value></String>
          <String><Key>Password</Key><Value ProtectInMemory="True">old</Value></String>
        </Entry>
      </History>
    </Entry>
  </Group>
  <Group><Name>Recycle Bin</Name>
    <Entry><String><Key>Title</Key><Value>Deleted</Value></String><String><Key>Password</Key><Value>x</Value></String></Entry>
  </Group>
</Group></Root></KeePassFile>"#;
        let mut entries = Vec::new();
        parse_keepass_xml(xml, "imported", &mut entries).unwrap();
        assert_eq!(
            entries.len(),
            1,
            "history and recycle bin must not import: {entries:?}"
        );
        let e = &entries[0];
        assert_eq!(e.title, "Mail");
        assert_eq!(e.folder, sanitize_folder("Work"));
        let field = |k: &str| {
            e.fields
                .iter()
                .find(|f| f.key == k)
                .map(|f| f.value.as_str())
        };
        assert_eq!(
            field("Password"),
            Some("p&ss<1>"),
            "protected value with entities"
        );
        assert_eq!(field("Username"), Some("me@example.com"));
        assert_eq!(field("URL"), None, "an empty value is not a field");
        assert_eq!(
            e.notes.lines().count(),
            3,
            "multi-line notes: {:?}",
            e.notes
        );
    }
}
