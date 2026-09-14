// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Media/attachment storage and image transformation.
//!
//! Images and attachments referenced from a note live in a `_media/` directory
//! beside the pages in the same folder. Files are content-addressed: the filename
//! is the first 16 hex chars of the SHA-256 of the bytes, which deduplicates
//! identical uploads automatically. Every save is validated for allowed extension
//! (see [`ALLOWED_EXTENSIONS`]), size (see [`MAX_FILE_SIZE`]), and magic-byte
//! signature matching the claimed type, so the extension cannot lie about content.
//!
//! Raster images can additionally be resized, rotated, re-encoded, and previewed
//! before saving via [`ImageTransformParams`] / [`preview_image_transform`] /
//! [`process_and_save_media`]. Markdown references files by a folder-relative
//! `_media/<hash>.<ext>` path; [`move_media_for_page`] copies referenced media
//! when a page moves between folders (copy, not move, since other pages may
//! reference the same content-addressed file).

use std::io::Cursor;
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use image::imageops::FilterType;
use image::DynamicImage;
use ring::digest::{digest, SHA256};
use serde::{Deserialize, Serialize};

use super::crud::safe_join;
use super::error::PageError;

/// Name of the per-folder directory that holds a folder's media/attachments.
pub const MEDIA_DIR: &str = "_media";
const MAX_FILE_SIZE: usize = 25 * 1024 * 1024; // 25 MB
const ALLOWED_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "gif", "webp", "svg", "pdf"];

// ── Image Transform ─────────────────────────────────────

/// Parameters for image transformation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageTransformParams {
    pub format: String,       // "original", "png", "jpeg", "webp", "gif"
    pub width: Option<u32>,   // Target width (None = derive from height/percent)
    pub height: Option<u32>,  // Target height (None = derive from width/percent)
    pub percent: Option<u32>, // Resize percentage (10-100, overrides width/height)
    pub rotation: u32,        // 0, 90, 180, 270
    pub quality: u32,         // 1-100 (for JPEG/WebP)
}

/// Preview result from image transform.
#[derive(Debug, Clone, Serialize)]
pub struct ImageTransformPreview {
    pub original_width: u32,
    pub original_height: u32,
    pub original_size: usize,
    pub original_format: String,
    pub output_width: u32,
    pub output_height: u32,
    pub output_size: usize,
    pub preview_data_url: String, // data:image/jpeg;base64,...
}

/// Transformable image formats (excludes SVG and PDF which aren't raster).
const TRANSFORMABLE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "gif", "webp"];

fn detect_format(ext: &str) -> &str {
    match ext {
        "jpg" | "jpeg" => "jpeg",
        "png" => "png",
        "gif" => "gif",
        "webp" => "webp",
        _ => "png",
    }
}

fn apply_transform(
    img: &DynamicImage,
    params: &ImageTransformParams,
    original_ext: &str,
) -> Result<(DynamicImage, String), PageError> {
    let mut result = img.clone();

    // 1. Resize
    let (orig_w, orig_h) = (img.width(), img.height());
    let (target_w, target_h) = if let Some(pct) = params.percent {
        let pct = pct.clamp(10, 100) as f64 / 100.0;
        ((orig_w as f64 * pct) as u32, (orig_h as f64 * pct) as u32)
    } else if let (Some(w), Some(h)) = (params.width, params.height) {
        (w.max(1), h.max(1))
    } else if let Some(w) = params.width {
        let ratio = w as f64 / orig_w as f64;
        (w.max(1), (orig_h as f64 * ratio) as u32)
    } else if let Some(h) = params.height {
        let ratio = h as f64 / orig_h as f64;
        ((orig_w as f64 * ratio) as u32, h.max(1))
    } else {
        (orig_w, orig_h)
    };

    if target_w != orig_w || target_h != orig_h {
        result = result.resize_exact(target_w, target_h, FilterType::Lanczos3);
    }

    // 2. Rotate
    result = match params.rotation {
        90 => result.rotate90(),
        180 => result.rotate180(),
        270 => result.rotate270(),
        _ => result,
    };

    // 3. Determine output format
    let output_format = if params.format == "original" {
        detect_format(original_ext).to_string()
    } else {
        params.format.clone()
    };

    Ok((result, output_format))
}

fn encode_image(img: &DynamicImage, format: &str, quality: u32) -> Result<Vec<u8>, PageError> {
    let mut buf = Cursor::new(Vec::new());
    let quality = quality.clamp(1, 100);

    match format {
        "jpeg" | "jpg" => {
            let encoder =
                image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, quality as u8);
            img.write_with_encoder(encoder)
                .map_err(|e| PageError::InvalidMedia(format!("JPEG encode failed: {e}")))?;
        }
        "png" => {
            img.write_to(&mut buf, image::ImageFormat::Png)
                .map_err(|e| PageError::InvalidMedia(format!("PNG encode failed: {e}")))?;
        }
        "webp" => {
            img.write_to(&mut buf, image::ImageFormat::WebP)
                .map_err(|e| PageError::InvalidMedia(format!("WebP encode failed: {e}")))?;
        }
        "gif" => {
            img.write_to(&mut buf, image::ImageFormat::Gif)
                .map_err(|e| PageError::InvalidMedia(format!("GIF encode failed: {e}")))?;
        }
        _ => {
            return Err(PageError::InvalidMedia(format!(
                "unsupported output format: {format}"
            )));
        }
    }

    Ok(buf.into_inner())
}

/// Preview an image transformation: returns original + output dimensions, estimated size,
/// and a base64 thumbnail preview.
pub fn preview_image_transform(
    source_path: &Path,
    params: &ImageTransformParams,
) -> Result<ImageTransformPreview, PageError> {
    let ext = source_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    if !TRANSFORMABLE_EXTENSIONS.contains(&ext.as_str()) {
        return Err(PageError::InvalidMedia(format!(
            "cannot transform .{ext} files — only raster images (PNG, JPEG, WebP, GIF)"
        )));
    }

    let file_data = std::fs::read(source_path)?;
    let original_size = file_data.len();

    let img = image::load_from_memory(&file_data)
        .map_err(|e| PageError::InvalidMedia(format!("failed to decode image: {e}")))?;

    let original_width = img.width();
    let original_height = img.height();
    let original_format = detect_format(&ext).to_string();

    // Apply transform
    let (transformed, output_format) = apply_transform(&img, params, &ext)?;
    let output_width = transformed.width();
    let output_height = transformed.height();

    // Encode to get actual output size
    let encoded = encode_image(&transformed, &output_format, params.quality)?;
    let output_size = encoded.len();

    // Generate thumbnail preview (max 300px on longest side)
    let thumb = if output_width > 300 || output_height > 300 {
        transformed.resize(300, 300, FilterType::Triangle)
    } else {
        transformed
    };
    let thumb_bytes = encode_image(&thumb, "jpeg", 75)?;
    let preview_data_url = format!("data:image/jpeg;base64,{}", BASE64.encode(&thumb_bytes));

    Ok(ImageTransformPreview {
        original_width,
        original_height,
        original_size,
        original_format,
        output_width,
        output_height,
        output_size,
        preview_data_url,
    })
}

/// Transform an image and save it to the vault's _media directory.
pub fn process_and_save_media(
    vault_dir: &Path,
    folder: &str,
    source_path: &Path,
    params: &ImageTransformParams,
) -> Result<MediaFile, PageError> {
    let ext = source_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    if !TRANSFORMABLE_EXTENSIONS.contains(&ext.as_str()) {
        return Err(PageError::InvalidMedia(format!(
            "cannot transform .{ext} files"
        )));
    }

    let file_data = std::fs::read(source_path)?;
    let img = image::load_from_memory(&file_data)
        .map_err(|e| PageError::InvalidMedia(format!("failed to decode image: {e}")))?;

    let (transformed, output_format) = apply_transform(&img, params, &ext)?;
    let encoded = encode_image(&transformed, &output_format, params.quality)?;

    // Save using the standard media pipeline (validates size, generates hash filename)
    let save_ext = match output_format.as_str() {
        "jpeg" => "jpg",
        other => other,
    };
    save_media(vault_dir, folder, &encoded, save_ext)
}

/// A saved media file, described by the several path forms callers need.
#[derive(Debug, Clone, Serialize)]
pub struct MediaFile {
    /// Vault-relative path, e.g. `general/_media/ab12cd34ef56.png`.
    pub rel_path: String,
    /// Path to embed in Markdown, relative to the page's folder, e.g.
    /// `_media/ab12cd34ef56.png`.
    pub md_path: String,
    /// Absolute filesystem path to the file on disk.
    pub abs_path: String,
    /// File size in bytes.
    pub size: usize,
}

/// Validate that the first bytes match the claimed file type.
fn validate_magic_bytes(data: &[u8], ext: &str) -> Result<(), PageError> {
    let valid = match ext {
        "jpg" | "jpeg" => data.len() >= 2 && data[0] == 0xFF && data[1] == 0xD8,
        "png" => data.len() >= 4 && data[..4] == [0x89, 0x50, 0x4E, 0x47],
        "gif" => data.len() >= 4 && &data[..4] == b"GIF8",
        "webp" => data.len() >= 12 && &data[..4] == b"RIFF" && &data[8..12] == b"WEBP",
        "svg" => {
            let text = std::str::from_utf8(data).unwrap_or("");
            text.contains("<svg")
        }
        "pdf" => data.len() >= 4 && &data[..4] == b"%PDF",
        _ => false,
    };
    if !valid {
        return Err(PageError::InvalidMedia(format!(
            "file content does not match extension .{ext}"
        )));
    }
    Ok(())
}

/// Compute a short hash filename from file content: first 16 hex chars of SHA-256.
fn hash_filename(data: &[u8]) -> String {
    let d = digest(&SHA256, data);
    let hex: String = d.as_ref().iter().map(|b| format!("{b:02x}")).collect();
    hex[..16].to_string()
}

/// Save media data to `{folder}/_media/{hash}.{ext}`.
pub fn save_media(
    vault_dir: &Path,
    folder: &str,
    data: &[u8],
    ext: &str,
) -> Result<MediaFile, PageError> {
    let ext_lower = ext.to_lowercase();
    if !ALLOWED_EXTENSIONS.contains(&ext_lower.as_str()) {
        return Err(PageError::InvalidMedia(format!(
            "unsupported file type: .{ext_lower}"
        )));
    }
    if data.len() > MAX_FILE_SIZE {
        return Err(PageError::InvalidMedia(format!(
            "file too large: {} bytes (max {})",
            data.len(),
            MAX_FILE_SIZE
        )));
    }
    validate_magic_bytes(data, &ext_lower)?;

    let hash = hash_filename(data);
    let media_rel = format!("{folder}/{MEDIA_DIR}");
    let media_dir = safe_join(vault_dir, &media_rel)?;
    std::fs::create_dir_all(&media_dir)?;

    let filename = format!("{hash}.{ext_lower}");
    let abs_path = media_dir.join(&filename);

    // Write file (deduplication: same hash = same content, safe to overwrite)
    std::fs::write(&abs_path, data)?;

    let rel_path = format!("{folder}/{MEDIA_DIR}/{filename}");
    let md_path = format!("{MEDIA_DIR}/{filename}");

    Ok(MediaFile {
        rel_path,
        md_path,
        abs_path: abs_path.to_string_lossy().to_string(),
        size: data.len(),
    })
}

/// Save media from a file path on disk.
pub fn save_media_from_path(
    vault_dir: &Path,
    folder: &str,
    source_path: &Path,
) -> Result<MediaFile, PageError> {
    let data = std::fs::read(source_path)?;
    let ext = source_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    save_media(vault_dir, folder, &data, ext)
}

/// Delete a media file. The rel_path must contain `/_media/`.
pub fn delete_media(vault_dir: &Path, rel_path: &str) -> Result<(), PageError> {
    if !rel_path.contains(&format!("/{MEDIA_DIR}/")) {
        return Err(PageError::InvalidMedia(
            "path is not a media file".to_string(),
        ));
    }
    let abs_path = safe_join(vault_dir, rel_path)?;
    if abs_path.exists() {
        std::fs::remove_file(&abs_path)?;
    }
    Ok(())
}

/// List all media files in a folder's `_media/` directory.
#[allow(dead_code)]
pub fn list_media(vault_dir: &Path, folder: &str) -> Result<Vec<MediaFile>, PageError> {
    let media_rel = format!("{folder}/{MEDIA_DIR}");
    let media_dir = safe_join(vault_dir, &media_rel)?;
    let mut files = Vec::new();

    if !media_dir.exists() {
        return Ok(files);
    }

    for entry in std::fs::read_dir(&media_dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_file() {
            let filename = entry.file_name().to_string_lossy().to_string();
            let metadata = entry.metadata()?;
            files.push(MediaFile {
                rel_path: format!("{folder}/{MEDIA_DIR}/{filename}"),
                md_path: format!("{MEDIA_DIR}/{filename}"),
                abs_path: path.to_string_lossy().to_string(),
                size: metadata.len() as usize,
            });
        }
    }

    Ok(files)
}

/// Resolve a markdown-relative media path to an absolute path.
pub fn resolve_media_path(
    vault_dir: &Path,
    folder: &str,
    md_path: &str,
) -> Result<PathBuf, PageError> {
    let rel = format!("{folder}/{md_path}");
    safe_join(vault_dir, &rel)
}

/// Parse `_media/` references from markdown content.
fn extract_media_refs(content: &str) -> Vec<String> {
    let mut refs = Vec::new();
    let pattern = &format!("]({MEDIA_DIR}/");
    let mut search_from = 0;
    while let Some(start) = content[search_from..].find(pattern) {
        let abs_start = search_from + start + 2; // skip "]("
        if let Some(end) = content[abs_start..].find(')') {
            let md_path = &content[abs_start..abs_start + end];
            if !refs.contains(&md_path.to_string()) {
                refs.push(md_path.to_string());
            }
            search_from = abs_start + end;
        } else {
            break;
        }
    }
    refs
}

/// Move media files referenced in content from old_folder to new_folder.
pub fn move_media_for_page(
    vault_dir: &Path,
    content: &str,
    old_folder: &str,
    new_folder: &str,
) -> Result<(), PageError> {
    let refs = extract_media_refs(content);
    if refs.is_empty() {
        return Ok(());
    }

    let new_media_rel = format!("{new_folder}/{MEDIA_DIR}");
    let new_media_dir = safe_join(vault_dir, &new_media_rel)?;
    std::fs::create_dir_all(&new_media_dir)?;

    for md_path in &refs {
        let old_rel = format!("{old_folder}/{md_path}");
        let old_abs = safe_join(vault_dir, &old_rel)?;
        if old_abs.exists() {
            let filename = old_abs
                .file_name()
                .ok_or_else(|| PageError::InvalidMedia("bad media path".into()))?;
            let new_abs = new_media_dir.join(filename);
            // Copy rather than move — other pages may reference the same file
            std::fs::copy(&old_abs, &new_abs)?;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn setup_vault() -> (tempfile::TempDir, PathBuf) {
        let dir = tempdir().unwrap();
        let vault = dir.path().to_path_buf();
        std::fs::create_dir_all(vault.join("general")).unwrap();
        (dir, vault)
    }

    // Minimal valid PNG: 8-byte signature
    fn minimal_png() -> Vec<u8> {
        let mut data = vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        // Pad to make it a reasonable size
        data.extend_from_slice(&[0u8; 100]);
        data
    }

    fn minimal_jpeg() -> Vec<u8> {
        let mut data = vec![0xFF, 0xD8, 0xFF, 0xE0];
        data.extend_from_slice(&[0u8; 100]);
        data
    }

    #[test]
    fn save_creates_file() {
        let (_dir, vault) = setup_vault();
        let data = minimal_png();
        let result = save_media(&vault, "general", &data, "png").unwrap();

        assert!(result.md_path.starts_with("_media/"));
        assert!(result.md_path.ends_with(".png"));
        assert!(result.rel_path.starts_with("general/_media/"));
        assert_eq!(result.size, data.len());
        assert!(PathBuf::from(&result.abs_path).exists());
    }

    #[test]
    fn save_deduplication() {
        let (_dir, vault) = setup_vault();
        let data = minimal_png();
        let r1 = save_media(&vault, "general", &data, "png").unwrap();
        let r2 = save_media(&vault, "general", &data, "png").unwrap();
        // Same content → same path
        assert_eq!(r1.md_path, r2.md_path);
    }

    #[test]
    fn rejects_oversized() {
        let (_dir, vault) = setup_vault();
        let data = vec![0x89, 0x50, 0x4E, 0x47]; // valid PNG header
        let big = [data.as_slice(), &vec![0u8; MAX_FILE_SIZE + 1]].concat();
        let result = save_media(&vault, "general", &big, "png");
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("too large"));
    }

    #[test]
    fn rejects_bad_extension() {
        let (_dir, vault) = setup_vault();
        let result = save_media(&vault, "general", b"hello", "exe");
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("unsupported"));
    }

    #[test]
    fn rejects_wrong_magic_bytes() {
        let (_dir, vault) = setup_vault();
        // Claim PNG but send JPEG magic bytes
        let result = save_media(&vault, "general", &minimal_jpeg(), "png");
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("does not match"));
    }

    #[test]
    fn delete_works() {
        let (_dir, vault) = setup_vault();
        let data = minimal_png();
        let mf = save_media(&vault, "general", &data, "png").unwrap();
        assert!(PathBuf::from(&mf.abs_path).exists());

        delete_media(&vault, &mf.rel_path).unwrap();
        assert!(!PathBuf::from(&mf.abs_path).exists());
    }

    #[test]
    fn delete_rejects_non_media_path() {
        let (_dir, vault) = setup_vault();
        let result = delete_media(&vault, "general/some-note.md");
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("not a media"));
    }

    #[test]
    fn list_returns_files() {
        let (_dir, vault) = setup_vault();
        let data = minimal_png();
        save_media(&vault, "general", &data, "png").unwrap();

        let files = list_media(&vault, "general").unwrap();
        assert_eq!(files.len(), 1);
        assert!(files[0].md_path.ends_with(".png"));
    }

    #[test]
    fn move_copies_files() {
        let (_dir, vault) = setup_vault();
        let data = minimal_png();
        let mf = save_media(&vault, "general", &data, "png").unwrap();

        let content = format!("![screenshot]({})", mf.md_path);
        std::fs::create_dir_all(vault.join("work")).unwrap();
        move_media_for_page(&vault, &content, "general", "work").unwrap();

        // File exists in new folder
        let new_files = list_media(&vault, "work").unwrap();
        assert_eq!(new_files.len(), 1);
        // Original still exists (copy, not move)
        assert!(PathBuf::from(&mf.abs_path).exists());
    }

    #[test]
    fn save_from_path_works() {
        let (_dir, vault) = setup_vault();
        let data = minimal_png();

        // Write to a temp file
        let tmp = vault.join("temp_upload.png");
        std::fs::write(&tmp, &data).unwrap();

        let result = save_media_from_path(&vault, "general", &tmp).unwrap();
        assert!(result.md_path.starts_with("_media/"));
        assert!(result.md_path.ends_with(".png"));
    }
}
