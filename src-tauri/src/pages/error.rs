// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Error type shared across the `pages` module.
//!
//! [`PageError`] covers every failure the page layer can produce — I/O, YAML
//! parsing, crypto, folder/media validation, and secret-block handling. It
//! implements [`serde::Serialize`] (as its `Display` string) so a returning
//! `Result<_, PageError>` from a `#[tauri::command]` surfaces to the frontend as
//! a plain error message string.

use thiserror::Error;

/// Any error produced while reading, writing, or transforming vault pages.
///
/// Each variant renders to a human-readable message (via `thiserror`) which is
/// what the React frontend receives when a command returns `Err`. The `#[from]`
/// variants ([`PageError::Io`], [`PageError::Yaml`]) let `?` bubble up underlying
/// std/serde errors transparently.
#[derive(Debug, Error)]
pub enum PageError {
    #[error("page not found: {0}")]
    NotFound(String),

    #[error("vault not open")]
    VaultNotOpen,

    #[error("invalid frontmatter: {0}")]
    InvalidFrontmatter(String),

    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("YAML error: {0}")]
    Yaml(#[from] serde_yaml::Error),

    #[error("trash error: {0}")]
    Trash(String),

    #[error("crypto error: {0}")]
    Crypto(String),

    #[error("folder already exists: {0}")]
    FolderExists(String),

    #[error("invalid folder name: {0}")]
    InvalidFolderName(String),

    #[error("cannot modify default folder")]
    DefaultFolder,

    #[error("folder not found: {0}")]
    FolderNotFound(String),

    #[error("invalid media: {0}")]
    InvalidMedia(String),

    #[error("secret block error: {0}")]
    SecretBlock(String),
}

impl serde::Serialize for PageError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
