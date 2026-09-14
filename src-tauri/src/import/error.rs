// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Error type for the import engine.
//!
//! Collapses the underlying `csv`, `quick-xml`, and `std::io` failures into two
//! user-facing categories (file read vs. parse) via `From` conversions, and is
//! serialized to the frontend so the import dialog can surface the reason.

use serde::Serialize;
use thiserror::Error;

/// Failure while reading or parsing a file being imported.
#[derive(Debug, Error, Serialize)]
pub enum ImportError {
    /// The file could not be opened or read from disk.
    #[error("Failed to read file: {0}")]
    FileRead(String),
    /// The file was read but its contents could not be parsed as the expected
    /// format (malformed CSV/XML, unexpected structure, etc.).
    #[error("Parse error: {0}")]
    Parse(String),
}

impl From<csv::Error> for ImportError {
    fn from(e: csv::Error) -> Self {
        ImportError::Parse(e.to_string())
    }
}

impl From<quick_xml::DeError> for ImportError {
    fn from(e: quick_xml::DeError) -> Self {
        ImportError::Parse(e.to_string())
    }
}

impl From<std::io::Error> for ImportError {
    fn from(e: std::io::Error) -> Self {
        ImportError::FileRead(e.to_string())
    }
}
