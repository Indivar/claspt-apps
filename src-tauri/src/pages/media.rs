// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Media/attachment storage and image transformation.
//!
//! Images and attachments referenced from a note live in a `_media/` directory
//! beside the pages in the same folder. Files are content-addressed: the filename
//! is the first 16 hex chars of the SHA-256 of the original bytes, which
//! deduplicates identical uploads automatically. Every save is validated for
//! allowed extension (see [`ALLOWED_EXTENSIONS`]), size (the vault's own limit,
//! never above [`MAX_ATTACHMENT_BYTES`]), and magic-byte signature matching the
//! claimed type, so the extension cannot lie about content.
//!
//! Whether a file is encrypted is the owner's choice per file, asked every time
//! ([`SaveOptions::encrypt`]). A plain attachment is stored byte for byte as it
//! was given and can be opened from the vault folder in Finder; a sealed one is
//! wrapped under the master key (see `claspt_core::crypto::attachment`) and
//! opens only inside Claspt. Both keep the same name, hashed from the original
//! bytes, and the same markdown reference, so a file can be sealed or unsealed
//! later without touching the page. Nothing is ever resized, re-encoded or
//! stripped of metadata unless the owner asks for a transform.
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

use super::crud::{safe_join, validate_folder_path};
use super::error::PageError;

/// Name of the per-folder directory that holds a folder's media/attachments.
pub const MEDIA_DIR: &str = "_media";
/// The most Claspt will ever store as one attachment, whatever a vault's own
/// limit says. A page is a note, not a file share; git carries every version.
pub const MAX_ATTACHMENT_LIMIT_MB: u32 = 25;
/// The per-vault limit a new vault starts with; see `VaultConfig`.
pub const DEFAULT_ATTACHMENT_LIMIT_MB: u32 = 5;
/// [`MAX_ATTACHMENT_LIMIT_MB`] in bytes.
pub const MAX_ATTACHMENT_BYTES: usize = MAX_ATTACHMENT_LIMIT_MB as usize * 1024 * 1024;
const ALLOWED_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "gif", "webp", "svg", "pdf"];

/// How a file is to be stored.
#[derive(Debug, Clone, Copy)]
pub struct SaveOptions {
    /// Seal the bytes under the master key. The owner's answer for this file.
    pub encrypt: bool,
    /// This vault's limit in bytes; clamped to [`MAX_ATTACHMENT_BYTES`].
    pub limit_bytes: usize,
}

impl SaveOptions {
    /// Options for a vault whose limit is `limit_mb`.
    pub fn new(encrypt: bool, limit_mb: u32) -> Self {
        let mb = limit_mb.clamp(1, MAX_ATTACHMENT_LIMIT_MB) as usize;
        Self {
            encrypt,
            limit_bytes: mb * 1024 * 1024,
        }
    }
}

/// A size for a sentence: "7.3 MB", "120.5 KB", "800 B".
pub fn human_size(bytes: usize) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = 1024.0 * 1024.0;
    let b = bytes as f64;
    if b >= MB {
        format!("{:.1} MB", b / MB)
    } else if b >= KB {
        format!("{:.1} KB", b / KB)
    } else {
        format!("{bytes} B")
    }
}

/// Total attachment storage in a vault: every file under every `_media/`.
#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct MediaUsage {
    pub files: u64,
    pub bytes: u64,
}

/// An attachment read back for display.
#[derive(Debug, Clone, Serialize)]
pub struct MediaRead {
    /// `data:<mime>;base64,...` of the original bytes.
    pub data_url: String,
    /// Whether the file on disk is sealed under the master key.
    pub sealed: bool,
    /// Size of the original bytes.
    pub size: usize,
    /// The file name inside `_media/`.
    pub name: String,
    pub ext: String,
    pub rel_path: String,
    pub md_path: String,
}

/// The largest source file a transform will read. Well above anything the
/// 25 MB save limit will ever produce, so a real photo is never refused, but a
/// bound rather than "whatever is on disk".
const MAX_TRANSFORM_SOURCE_BYTES: u64 = 64 * 1024 * 1024;
/// Widest and tallest image the decoder will accept. The `image` crate's own
/// default limit is on allocation (512 MiB) with no cap on dimensions, so an
/// 11k by 11k image decodes and then every later step (clone, resize, encode)
/// runs without any limit at all.
const MAX_DECODE_DIMENSION: u32 = 16_384;
/// Largest side of a transform's output. Caller-supplied `width` and `height`
/// used to be floored at one and never capped, so a target of a million
/// pixels a side panicked inside the resize or exhausted memory.
const MAX_OUTPUT_DIMENSION: u32 = 8_192;

/// Decode raster image bytes under explicit dimension limits.
fn decode_image(data: &[u8]) -> Result<DynamicImage, PageError> {
    let mut reader = image::ImageReader::new(Cursor::new(data))
        .with_guessed_format()
        .map_err(|e| PageError::InvalidMedia(format!("failed to read image: {e}")))?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_DECODE_DIMENSION);
    limits.max_image_height = Some(MAX_DECODE_DIMENSION);
    reader.limits(limits);
    reader
        .decode()
        .map_err(|e| PageError::InvalidMedia(format!("failed to decode image: {e}")))
}

/// Read a transform's source file, refusing one over [`MAX_TRANSFORM_SOURCE_BYTES`]
/// before any of it is loaded.
fn read_transform_source(source_path: &Path) -> Result<Vec<u8>, PageError> {
    let len = std::fs::metadata(source_path)?.len();
    if len > MAX_TRANSFORM_SOURCE_BYTES {
        return Err(PageError::InvalidMedia(format!(
            "source image too large: {len} bytes (max {MAX_TRANSFORM_SOURCE_BYTES})"
        )));
    }
    Ok(std::fs::read(source_path)?)
}

/// Clamp a requested output side to `1..=MAX_OUTPUT_DIMENSION`.
fn output_side(value: u32) -> u32 {
    value.clamp(1, MAX_OUTPUT_DIMENSION)
}

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
        (w, h)
    } else if let Some(w) = params.width {
        let ratio = w as f64 / orig_w as f64;
        (w, (orig_h as f64 * ratio) as u32)
    } else if let Some(h) = params.height {
        let ratio = h as f64 / orig_h as f64;
        ((orig_w as f64 * ratio) as u32, h)
    } else {
        (orig_w, orig_h)
    };
    let (target_w, target_h) = (output_side(target_w), output_side(target_h));

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

/// Preview an image transform on raw `data` with extension `ext`.
///
/// The bytes are the source as given; the preview is a JPEG thumbnail and
/// the numbers say what saving with these params would produce. Nothing is
/// written.
pub fn preview_image_transform_bytes(
    data: &[u8],
    ext: &str,
    params: &ImageTransformParams,
) -> Result<ImageTransformPreview, PageError> {
    let ext = ext.to_lowercase();
    if !TRANSFORMABLE_EXTENSIONS.contains(&ext.as_str()) {
        return Err(PageError::InvalidMedia(format!(
            "cannot transform .{ext} files — only raster images (PNG, JPEG, WebP, GIF)"
        )));
    }
    if data.len() as u64 > MAX_TRANSFORM_SOURCE_BYTES {
        return Err(PageError::InvalidMedia(format!(
            "source image too large: {} bytes (max {MAX_TRANSFORM_SOURCE_BYTES})",
            data.len()
        )));
    }
    let original_size = data.len();
    let img = decode_image(data)?;

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

    // Generate a small JPEG thumbnail for the preview (max 400px wide)
    let thumb = if transformed.width() > 400 {
        transformed.resize(400, u32::MAX, FilterType::Triangle)
    } else {
        transformed.clone()
    };
    let thumb_bytes = encode_image(&thumb, "jpeg", 70)?;
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

/// Preview an image transform for a file on disk.
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
    let file_data = read_transform_source(source_path)?;
    preview_image_transform_bytes(&file_data, &ext, params)
}

/// Transform raw image `data` and save the result to the vault's _media
/// directory. This is the one path that changes bytes, and only because the
/// owner chose a transform.
pub fn process_and_save_media_bytes(
    vault_dir: &Path,
    folder: &str,
    data: &[u8],
    ext: &str,
    params: &ImageTransformParams,
    opts: &SaveOptions,
    master_key: Option<&[u8]>,
) -> Result<MediaFile, PageError> {
    let ext = ext.to_lowercase();
    if !TRANSFORMABLE_EXTENSIONS.contains(&ext.as_str()) {
        return Err(PageError::InvalidMedia(format!(
            "cannot transform .{ext} files"
        )));
    }
    if data.len() as u64 > MAX_TRANSFORM_SOURCE_BYTES {
        return Err(PageError::InvalidMedia(format!(
            "source image too large: {} bytes (max {MAX_TRANSFORM_SOURCE_BYTES})",
            data.len()
        )));
    }
    let img = decode_image(data)?;
    let (transformed, output_format) = apply_transform(&img, params, &ext)?;
    let encoded = encode_image(&transformed, &output_format, params.quality)?;

    // Save using the standard media pipeline (validates size, generates hash filename)
    let save_ext = match output_format.as_str() {
        "jpeg" => "jpg",
        other => other,
    };
    save_media(vault_dir, folder, &encoded, save_ext, opts, master_key)
}

/// Transform an image on disk and save it to the vault's _media directory.
pub fn process_and_save_media(
    vault_dir: &Path,
    folder: &str,
    source_path: &Path,
    params: &ImageTransformParams,
    opts: &SaveOptions,
    master_key: Option<&[u8]>,
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
    let file_data = read_transform_source(source_path)?;
    process_and_save_media_bytes(
        vault_dir, folder, &file_data, &ext, params, opts, master_key,
    )
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
    /// Size of the original bytes, before any sealing.
    pub size: usize,
    /// Whether the file on disk is sealed under the master key.
    pub sealed: bool,
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
///
/// `data` is stored exactly as given when `opts.encrypt` is false; sealed
/// under `master_key` when it is true. The name is the hash of the original
/// bytes either way. A file over `opts.limit_bytes` is refused with both
/// numbers in the message; the caller decides whether to raise the limit or
/// shrink an image, and nothing happens to the bytes without that choice.
pub fn save_media(
    vault_dir: &Path,
    folder: &str,
    data: &[u8],
    ext: &str,
    opts: &SaveOptions,
    master_key: Option<&[u8]>,
) -> Result<MediaFile, PageError> {
    let ext_lower = ext.to_lowercase();
    if !ALLOWED_EXTENSIONS.contains(&ext_lower.as_str()) {
        return Err(PageError::InvalidMedia(format!(
            "unsupported file type: .{ext_lower}"
        )));
    }
    let limit = opts.limit_bytes.min(MAX_ATTACHMENT_BYTES);
    if data.len() > limit {
        return Err(PageError::InvalidMedia(format!(
            "attachment too large: {} — this vault's limit is {} MB (Claspt allows at most {} MB)",
            human_size(data.len()),
            limit / (1024 * 1024),
            MAX_ATTACHMENT_LIMIT_MB
        )));
    }
    validate_magic_bytes(data, &ext_lower)?;

    let hash = hash_filename(data);
    let media_rel = format!("{folder}/{MEDIA_DIR}");
    let media_dir = safe_join(vault_dir, &media_rel)?;
    std::fs::create_dir_all(&media_dir)?;

    let filename = format!("{hash}.{ext_lower}");
    let abs_path = media_dir.join(&filename);

    let on_disk: std::borrow::Cow<'_, [u8]> = if opts.encrypt {
        let key = master_key.ok_or_else(|| {
            PageError::Crypto("the vault must be unlocked to encrypt an attachment".into())
        })?;
        std::borrow::Cow::Owned(
            claspt_core::crypto::attachment::seal(key, data)
                .map_err(|e| PageError::Crypto(e.to_string()))?,
        )
    } else {
        std::borrow::Cow::Borrowed(data)
    };
    // Deduplication: same original bytes, same name, safe to overwrite. A
    // plain copy replacing a sealed one (or the reverse) is the owner's
    // latest answer for these bytes.
    std::fs::write(&abs_path, &on_disk)?;

    let rel_path = format!("{folder}/{MEDIA_DIR}/{filename}");
    let md_path = format!("{MEDIA_DIR}/{filename}");

    Ok(MediaFile {
        rel_path,
        md_path,
        abs_path: abs_path.to_string_lossy().to_string(),
        size: data.len(),
        sealed: opts.encrypt,
    })
}

/// Save media from a file path on disk.
pub fn save_media_from_path(
    vault_dir: &Path,
    folder: &str,
    source_path: &Path,
    opts: &SaveOptions,
    master_key: Option<&[u8]>,
) -> Result<MediaFile, PageError> {
    let len = std::fs::metadata(source_path)?.len();
    if len > MAX_ATTACHMENT_BYTES as u64 {
        return Err(PageError::InvalidMedia(format!(
            "attachment too large: {} — this vault's limit is {} MB (Claspt allows at most {} MB)",
            human_size(len as usize),
            opts.limit_bytes.min(MAX_ATTACHMENT_BYTES) / (1024 * 1024),
            MAX_ATTACHMENT_LIMIT_MB
        )));
    }
    let data = std::fs::read(source_path)?;
    let ext = source_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    save_media(vault_dir, folder, &data, ext, opts, master_key)
}

/// The on-disk path of `rel_path` (`<folder>/_media/<file>`), checked the same
/// way a markdown reference is.
fn media_file_path(vault_dir: &Path, rel_path: &str) -> Result<PathBuf, PageError> {
    let marker = format!("/{MEDIA_DIR}/");
    let (folder, file) = rel_path
        .split_once(&marker)
        .ok_or_else(|| PageError::InvalidMedia("path is not a media file".to_string()))?;
    resolve_media_path(vault_dir, folder, &format!("{MEDIA_DIR}/{file}"))
}

/// The MIME type an attachment is served as, by extension.
fn mime_for(ext: &str) -> &'static str {
    match ext {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

/// The original bytes of `abs_path`, opening a sealed file with `master_key`.
fn read_original_bytes(
    abs_path: &Path,
    master_key: Option<&[u8]>,
) -> Result<(Vec<u8>, bool), PageError> {
    let on_disk = std::fs::read(abs_path)?;
    if !claspt_core::crypto::attachment::is_sealed(&on_disk) {
        return Ok((on_disk, false));
    }
    let key = master_key.ok_or_else(|| {
        PageError::Crypto("this attachment is encrypted; unlock the vault to open it".into())
    })?;
    let plain = claspt_core::crypto::attachment::open(key, &on_disk)
        .map_err(|e| PageError::Crypto(e.to_string()))?;
    Ok((plain, true))
}

/// Read an attachment referenced from a page as a data URL, opening a sealed
/// one with `master_key`. With `include_data` false the file is described
/// but not read or opened and `data_url` is empty: a PDF is shown as a chip,
/// never inline, so its bytes have no reason to cross into the webview.
pub fn read_media(
    vault_dir: &Path,
    folder: &str,
    md_path: &str,
    master_key: Option<&[u8]>,
    include_data: bool,
) -> Result<MediaRead, PageError> {
    let abs = resolve_media_path(vault_dir, folder, md_path)?;
    let name = abs
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let ext = abs
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let (data_url, sealed, size) = if include_data {
        let (data, sealed) = read_original_bytes(&abs, master_key)?;
        let url = format!("data:{};base64,{}", mime_for(&ext), BASE64.encode(&data));
        (url, sealed, data.len())
    } else {
        let sealed = sealed_on_disk(&abs);
        let on_disk = std::fs::metadata(&abs)?.len() as usize;
        let size = if sealed {
            on_disk.saturating_sub(claspt_core::crypto::attachment::OVERHEAD)
        } else {
            on_disk
        };
        (String::new(), sealed, size)
    };
    Ok(MediaRead {
        data_url,
        sealed,
        size,
        name,
        ext,
        rel_path: format!("{}/{md_path}", folder.trim()),
        md_path: md_path.to_string(),
    })
}

/// The original bytes of the attachment at `rel_path`, for saving a copy
/// outside the vault.
pub fn read_media_bytes(
    vault_dir: &Path,
    rel_path: &str,
    master_key: Option<&[u8]>,
) -> Result<Vec<u8>, PageError> {
    let abs = media_file_path(vault_dir, rel_path)?;
    Ok(read_original_bytes(&abs, master_key)?.0)
}

/// Seal (`encrypt == true`) or unseal the attachment at `rel_path` in place.
/// The name and every reference to it stay as they are; only the bytes on
/// disk change. Already in the requested state is not an error.
pub fn set_media_sealed(
    vault_dir: &Path,
    rel_path: &str,
    encrypt: bool,
    master_key: &[u8],
) -> Result<MediaFile, PageError> {
    let abs = media_file_path(vault_dir, rel_path)?;
    let (plain, was_sealed) = read_original_bytes(&abs, Some(master_key))?;
    if was_sealed != encrypt {
        let on_disk = if encrypt {
            claspt_core::crypto::attachment::seal(master_key, &plain)
                .map_err(|e| PageError::Crypto(e.to_string()))?
        } else {
            plain.clone()
        };
        std::fs::write(&abs, on_disk)?;
    }
    let file = abs
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    Ok(MediaFile {
        rel_path: rel_path.to_string(),
        md_path: format!("{MEDIA_DIR}/{file}"),
        abs_path: abs.to_string_lossy().to_string(),
        size: plain.len(),
        sealed: encrypt,
    })
}

/// Every attachment in the vault, counted and summed by on-disk size. Walks
/// the page folders only: dot-directories (`.securenotes`, `.git`) hold no
/// attachments and are not entered.
pub fn usage(vault_dir: &Path) -> Result<MediaUsage, PageError> {
    let mut total = MediaUsage::default();
    fn walk(dir: &Path, total: &mut MediaUsage) -> std::io::Result<()> {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let path = entry.path();
            if !path.is_dir() || name.starts_with('.') {
                continue;
            }
            if name == MEDIA_DIR {
                for file in std::fs::read_dir(&path)? {
                    let file = file?;
                    if file.path().is_file() {
                        total.files += 1;
                        total.bytes += file.metadata()?.len();
                    }
                }
            } else {
                walk(&path, total)?;
            }
        }
        Ok(())
    }
    walk(vault_dir, &mut total)?;
    Ok(total)
}

/// The pages of a folder that still reference an attachment, so that
/// deleting it can say what else will lose it. An encrypted page's body
/// cannot be scanned, so those are counted separately rather than assumed
/// clean.
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct MediaReferences {
    /// Vault-relative paths of the plaintext pages that reference the file.
    pub pages: Vec<String>,
    /// Encrypted pages in the same folder, whose bodies could not be checked.
    pub unchecked_encrypted: u64,
}

/// Find every page in `folder` whose body references `md_path`
/// (the `_media/<name>` form pages use). The match is on the link target
/// itself, so a page that merely mentions the name in prose is not counted.
pub fn references(
    vault_dir: &Path,
    folder: &str,
    md_path: &str,
) -> Result<MediaReferences, PageError> {
    validate_folder_path(folder)?;
    let prefix = format!("{folder}/");
    let mut refs = MediaReferences::default();
    super::crud::walk_vault_pages(vault_dir, |rel_path, meta, content| {
        if !rel_path.starts_with(&prefix) || rel_path[prefix.len()..].contains('/') {
            return;
        }
        if meta.encrypted {
            refs.unchecked_encrypted += 1;
        } else if links_to(&content, md_path) {
            refs.pages.push(rel_path);
        }
    })?;
    refs.pages.sort();
    Ok(refs)
}

/// Whether `content` links to `md_path` as an image target. The target may
/// be followed by a title, the owner's comment: `](_media/x.pdf "why")`.
/// Counting only the bare form made a commented attachment look unused.
fn links_to(content: &str, md_path: &str) -> bool {
    content.contains(&format!("]({md_path})")) || content.contains(&format!("]({md_path} "))
}

/// Delete a media file. The rel_path must contain `/_media/`.
pub fn delete_media(vault_dir: &Path, rel_path: &str) -> Result<(), PageError> {
    let abs_path = media_file_path(vault_dir, rel_path)?;
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
            let sealed = sealed_on_disk(&path);
            files.push(MediaFile {
                rel_path: format!("{folder}/{MEDIA_DIR}/{filename}"),
                md_path: format!("{MEDIA_DIR}/{filename}"),
                abs_path: path.to_string_lossy().to_string(),
                size: metadata.len() as usize,
                sealed,
            });
        }
    }

    Ok(files)
}

/// Whether the file at `path` starts with the sealed-attachment magic. Reads
/// only the header, so listing a folder does not read every attachment.
fn sealed_on_disk(path: &Path) -> bool {
    use std::io::Read;
    let magic = claspt_core::crypto::attachment::MAGIC;
    let mut head = vec![0u8; magic.len()];
    std::fs::File::open(path)
        .and_then(|mut f| f.read_exact(&mut head))
        .map(|()| head == magic)
        .unwrap_or(false)
}

/// Resolve a markdown-relative media path to an absolute path.
///
/// Only `_media/<file>` directly under the page's folder resolves: exactly one
/// segment after the media directory, an allow-listed extension, and a folder
/// that passes the same validation as every other folder input. The preview
/// hands this whatever path it finds in an image tag and the folder comes
/// from the page's own frontmatter, so without the constraint a synced page
/// carrying `folder: .` and `![x](.securenotes/clients.json)` had the
/// renderer read the API client registry as a data URL.
pub fn resolve_media_path(
    vault_dir: &Path,
    folder: &str,
    md_path: &str,
) -> Result<PathBuf, PageError> {
    validate_folder_path(folder)?;
    let file = md_path
        .strip_prefix(&format!("{MEDIA_DIR}/"))
        .ok_or_else(|| PageError::InvalidMedia(format!("not a media path: {md_path}")))?;
    if file.is_empty() || file.starts_with('.') || file.contains(['/', '\\']) {
        return Err(PageError::InvalidMedia(format!(
            "not a media path: {md_path}"
        )));
    }
    let ext = Path::new(file)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_lowercase)
        .unwrap_or_default();
    if !ALLOWED_EXTENSIONS.contains(&ext.as_str()) {
        return Err(PageError::InvalidMedia(format!(
            "unsupported file type: .{ext}"
        )));
    }
    let rel = format!("{}/{MEDIA_DIR}/{file}", folder.trim());
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

    fn page(vault: &Path, rel: &str, title: &str, body: &str) {
        let text = format!(
            "---\nid: {title}\ntitle: {title}\ncreated_at: 2026-01-01T00:00:00Z\nupdated_at: 2026-01-01T00:00:00Z\n---\n{body}"
        );
        std::fs::write(vault.join(rel), text).unwrap();
    }

    #[test]
    fn describing_a_sealed_file_without_data_needs_no_key_and_states_the_original_size() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("general")).unwrap();
        let opts = SaveOptions::new(true, 5);
        let sealed = save_media(
            dir.path(),
            "general",
            b"%PDF-1.4 not really",
            "pdf",
            &opts,
            Some(&KEY),
        )
        .unwrap();
        let described = read_media(dir.path(), "general", &sealed.md_path, None, false).unwrap();
        assert!(described.sealed);
        assert!(described.data_url.is_empty());
        assert_eq!(described.size, b"%PDF-1.4 not really".len());
        assert_eq!(described.ext, "pdf");
        let opened = read_media(dir.path(), "general", &sealed.md_path, Some(&KEY), true).unwrap();
        assert_eq!(opened.size, described.size);
        assert!(opened.data_url.starts_with("data:application/pdf;base64,"));
    }

    #[test]
    fn references_finds_link_targets_in_the_folder_only() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        std::fs::create_dir_all(vault.join("general/_media")).unwrap();
        std::fs::create_dir_all(vault.join("general/sub")).unwrap();
        std::fs::create_dir_all(vault.join("other")).unwrap();
        page(vault, "general/a.md", "a", "![shot](_media/abc.png)\n");
        page(
            vault,
            "general/b.md",
            "b",
            "the file abc.png is mentioned, not linked\n",
        );
        page(
            vault,
            "general/c.md",
            "c",
            "twice ![x](_media/abc.png) and ![y](_media/abc.png)\n",
        );
        page(vault, "general/sub/d.md", "d", "![shot](_media/abc.png)\n");
        page(vault, "other/e.md", "e", "![shot](_media/abc.png)\n");

        let refs = references(vault, "general", "_media/abc.png").unwrap();
        assert_eq!(
            refs.pages,
            vec!["general/a.md".to_string(), "general/c.md".to_string()]
        );
        assert_eq!(refs.unchecked_encrypted, 0);
        assert_eq!(
            references(vault, "other", "_media/abc.png").unwrap().pages,
            vec!["other/e.md"]
        );
        assert!(references(vault, "../general", "_media/abc.png").is_err());
    }

    #[test]
    fn a_reference_with_a_comment_still_counts() {
        assert!(links_to(
            "![a](_media/x.pdf \"the scan from May\")\n",
            "_media/x.pdf"
        ));
        assert!(links_to("![a](_media/x.pdf)", "_media/x.pdf"));
        assert!(!links_to("![a](_media/x.pdf2)", "_media/x.pdf"));
        assert!(!links_to("mentions _media/x.pdf in prose", "_media/x.pdf"));
    }

    #[test]
    fn references_counts_encrypted_pages_as_unchecked() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        std::fs::create_dir_all(vault.join("general")).unwrap();
        std::fs::write(
            vault.join("general/enc.md"),
            "---\nid: enc\ntitle: enc\ncreated_at: 2026-01-01T00:00:00Z\nupdated_at: 2026-01-01T00:00:00Z\nencrypted: true\n---\nenc:v1:AAAA\n",
        )
        .unwrap();
        let refs = references(vault, "general", "_media/abc.png").unwrap();
        assert!(refs.pages.is_empty());
        assert_eq!(refs.unchecked_encrypted, 1);
    }

    #[test]
    fn media_paths_resolve_only_inside_the_folder_media_dir() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        std::fs::create_dir_all(vault.join("general/_media")).unwrap();
        std::fs::create_dir_all(vault.join(".securenotes")).unwrap();
        std::fs::write(vault.join("general/_media/abc.png"), b"x").unwrap();
        std::fs::write(vault.join(".securenotes/clients.json"), b"{}").unwrap();

        let ok = resolve_media_path(vault, "general", "_media/abc.png").unwrap();
        assert!(ok.ends_with("general/_media/abc.png"));

        // The registry the preview once read as an image.
        assert!(resolve_media_path(vault, ".", ".securenotes/clients.json").is_err());
        assert!(resolve_media_path(vault, "general", "../.securenotes/clients.json").is_err());
        // Only one segment after `_media/`, no hidden files, allow-listed types.
        assert!(resolve_media_path(vault, "general", "_media/sub/abc.png").is_err());
        assert!(resolve_media_path(vault, "general", "_media/.abc.png").is_err());
        assert!(resolve_media_path(vault, "general", "_media/abc.html").is_err());
        assert!(resolve_media_path(vault, "general", "abc.png").is_err());
        assert!(resolve_media_path(vault, ".securenotes", "_media/abc.png").is_err());
    }

    const KEY: [u8; 32] = [6u8; 32];
    /// A tiny valid PNG header plus filler: enough for the magic check.
    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR-test-bytes";

    fn vault() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("general")).unwrap();
        dir
    }

    /// A plain attachment is the bytes as given; a sealed one is not, but
    /// reads back identical, and both carry the same name and reference.
    #[test]
    fn plain_and_sealed_saves_keep_the_name_and_the_bytes() {
        let dir = vault();
        let limit = SaveOptions::new(false, 5);
        let plain = save_media(dir.path(), "general", PNG, "png", &limit, None).unwrap();
        assert!(!plain.sealed);
        assert_eq!(
            std::fs::read(&plain.abs_path).unwrap(),
            PNG,
            "plain bytes must be stored exactly"
        );

        let sealed_opts = SaveOptions::new(true, 5);
        let sealed =
            save_media(dir.path(), "general", PNG, "png", &sealed_opts, Some(&KEY)).unwrap();
        assert!(sealed.sealed);
        assert_eq!(
            sealed.md_path, plain.md_path,
            "sealing must not change the reference"
        );
        let on_disk = std::fs::read(&sealed.abs_path).unwrap();
        assert!(claspt_core::crypto::attachment::is_sealed(&on_disk));
        assert!(
            !on_disk.windows(4).any(|w| w == b"IHDR"),
            "sealed file leaks plaintext"
        );

        let read = read_media(dir.path(), "general", &sealed.md_path, Some(&KEY), true).unwrap();
        assert!(read.sealed);
        assert_eq!(read.size, PNG.len());
        assert!(read.data_url.starts_with("data:image/png;base64,"));
        assert!(
            read_media(dir.path(), "general", &sealed.md_path, None, true).is_err(),
            "a sealed file needs the key"
        );
        // Sealing needs the key too; without it nothing is written.
        assert!(save_media(dir.path(), "general", PNG, "png", &sealed_opts, None).is_err());
    }

    #[test]
    fn the_vault_limit_is_enforced_with_both_numbers_stated() {
        let dir = vault();
        let mut big = PNG.to_vec();
        big.resize(2 * 1024 * 1024 + 1, 0);
        let err = save_media(
            dir.path(),
            "general",
            &big,
            "png",
            &SaveOptions::new(false, 2),
            None,
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("2.0 MB"), "{err}");
        assert!(err.contains("limit is 2 MB"), "{err}");
        assert!(err.contains("at most 25 MB"), "{err}");
        // The hard ceiling holds whatever the vault says.
        assert_eq!(
            SaveOptions::new(false, 99).limit_bytes,
            MAX_ATTACHMENT_BYTES
        );
        assert_eq!(SaveOptions::new(false, 0).limit_bytes, 1024 * 1024);
        // Within the limit is fine.
        assert!(save_media(
            dir.path(),
            "general",
            &big,
            "png",
            &SaveOptions::new(false, 3),
            None
        )
        .is_ok());
    }

    #[test]
    fn sealing_and_unsealing_in_place_keep_the_name() {
        let dir = vault();
        let plain = save_media(
            dir.path(),
            "general",
            PNG,
            "png",
            &SaveOptions::new(false, 5),
            None,
        )
        .unwrap();
        let sealed = set_media_sealed(dir.path(), &plain.rel_path, true, &KEY).unwrap();
        assert_eq!(sealed.rel_path, plain.rel_path);
        assert!(sealed.sealed);
        assert!(claspt_core::crypto::attachment::is_sealed(
            &std::fs::read(&plain.abs_path).unwrap()
        ));
        // Idempotent.
        assert!(
            set_media_sealed(dir.path(), &plain.rel_path, true, &KEY)
                .unwrap()
                .sealed
        );
        let back = set_media_sealed(dir.path(), &plain.rel_path, false, &KEY).unwrap();
        assert!(!back.sealed);
        assert_eq!(std::fs::read(&plain.abs_path).unwrap(), PNG);
        // A path outside any _media directory is refused.
        assert!(set_media_sealed(dir.path(), "general/page.md", true, &KEY).is_err());
        assert!(set_media_sealed(dir.path(), ".securenotes/_media/x.png", true, &KEY).is_err());
        assert!(read_media_bytes(dir.path(), &plain.rel_path, None).unwrap() == PNG);
    }

    #[test]
    fn usage_counts_every_attachment_and_nothing_else() {
        let dir = vault();
        std::fs::create_dir_all(dir.path().join("work/aws")).unwrap();
        std::fs::create_dir_all(dir.path().join(".securenotes/_media")).unwrap();
        std::fs::write(dir.path().join(".securenotes/_media/no.png"), PNG).unwrap();
        std::fs::write(dir.path().join("general/page.md"), "not an attachment").unwrap();
        save_media(
            dir.path(),
            "general",
            PNG,
            "png",
            &SaveOptions::new(false, 5),
            None,
        )
        .unwrap();
        save_media(
            dir.path(),
            "work/aws",
            b"%PDF-1.4 tiny",
            "pdf",
            &SaveOptions::new(true, 5),
            Some(&KEY),
        )
        .unwrap();
        let total = usage(dir.path()).unwrap();
        assert_eq!(total.files, 2);
        let sealed_len = std::fs::metadata(
            list_media(dir.path(), "work/aws").unwrap()[0]
                .abs_path
                .clone(),
        )
        .unwrap()
        .len();
        assert_eq!(total.bytes, PNG.len() as u64 + sealed_len);
        let listed = list_media(dir.path(), "work/aws").unwrap();
        assert!(listed[0].sealed);
        assert!(!list_media(dir.path(), "general").unwrap()[0].sealed);
    }

    #[test]
    fn human_sizes_read_naturally() {
        assert_eq!(human_size(800), "800 B");
        assert_eq!(human_size(120 * 1024 + 512), "120.5 KB");
        assert_eq!(human_size(7 * 1024 * 1024 + 300 * 1024), "7.3 MB");
    }

    #[test]
    fn output_sides_are_capped() {
        assert_eq!(output_side(0), 1);
        assert_eq!(output_side(640), 640);
        assert_eq!(output_side(u32::MAX), MAX_OUTPUT_DIMENSION);
    }
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
        let result = save_media(
            &vault,
            "general",
            &data,
            "png",
            &SaveOptions::new(false, MAX_ATTACHMENT_LIMIT_MB),
            None,
        )
        .unwrap();

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
        let r1 = save_media(
            &vault,
            "general",
            &data,
            "png",
            &SaveOptions::new(false, MAX_ATTACHMENT_LIMIT_MB),
            None,
        )
        .unwrap();
        let r2 = save_media(
            &vault,
            "general",
            &data,
            "png",
            &SaveOptions::new(false, MAX_ATTACHMENT_LIMIT_MB),
            None,
        )
        .unwrap();
        // Same content → same path
        assert_eq!(r1.md_path, r2.md_path);
    }

    #[test]
    fn rejects_oversized() {
        let (_dir, vault) = setup_vault();
        let data = vec![0x89, 0x50, 0x4E, 0x47]; // valid PNG header
        let big = [data.as_slice(), &vec![0u8; MAX_ATTACHMENT_BYTES + 1]].concat();
        let result = save_media(
            &vault,
            "general",
            &big,
            "png",
            &SaveOptions::new(false, MAX_ATTACHMENT_LIMIT_MB),
            None,
        );
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("too large"));
    }

    #[test]
    fn rejects_bad_extension() {
        let (_dir, vault) = setup_vault();
        let result = save_media(
            &vault,
            "general",
            b"hello",
            "exe",
            &SaveOptions::new(false, MAX_ATTACHMENT_LIMIT_MB),
            None,
        );
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("unsupported"));
    }

    #[test]
    fn rejects_wrong_magic_bytes() {
        let (_dir, vault) = setup_vault();
        // Claim PNG but send JPEG magic bytes
        let result = save_media(
            &vault,
            "general",
            &minimal_jpeg(),
            "png",
            &SaveOptions::new(false, MAX_ATTACHMENT_LIMIT_MB),
            None,
        );
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("does not match"));
    }

    #[test]
    fn delete_works() {
        let (_dir, vault) = setup_vault();
        let data = minimal_png();
        let mf = save_media(
            &vault,
            "general",
            &data,
            "png",
            &SaveOptions::new(false, MAX_ATTACHMENT_LIMIT_MB),
            None,
        )
        .unwrap();
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
        save_media(
            &vault,
            "general",
            &data,
            "png",
            &SaveOptions::new(false, MAX_ATTACHMENT_LIMIT_MB),
            None,
        )
        .unwrap();

        let files = list_media(&vault, "general").unwrap();
        assert_eq!(files.len(), 1);
        assert!(files[0].md_path.ends_with(".png"));
    }

    #[test]
    fn move_copies_files() {
        let (_dir, vault) = setup_vault();
        let data = minimal_png();
        let mf = save_media(
            &vault,
            "general",
            &data,
            "png",
            &SaveOptions::new(false, MAX_ATTACHMENT_LIMIT_MB),
            None,
        )
        .unwrap();

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

        let result = save_media_from_path(
            &vault,
            "general",
            &tmp,
            &SaveOptions::new(false, MAX_ATTACHMENT_LIMIT_MB),
            None,
        )
        .unwrap();
        assert!(result.md_path.starts_with("_media/"));
        assert!(result.md_path.ends_with(".png"));
    }
}
