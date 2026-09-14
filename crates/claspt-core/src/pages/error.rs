// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Error type for page parsing, serialization, and secret (de)encryption.
use thiserror::Error;

/// Failure modes of page and secret-block operations.
#[derive(Debug, Error)]
pub enum PageError {
    /// No page exists at the requested id or path.
    #[error("page not found: {0}")]
    NotFound(String),

    /// The YAML frontmatter was missing, malformed, oversized, or had bad control chars.
    #[error("invalid frontmatter: {0}")]
    InvalidFrontmatter(String),

    /// An underlying filesystem read/write failed.
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    /// The frontmatter YAML failed to deserialize into [`super::model::PageMeta`].
    #[error("YAML error: {0}")]
    Yaml(#[from] serde_yaml::Error),

    /// A secret block failed to encrypt or decrypt (carries the crypto message).
    #[error("crypto error: {0}")]
    Crypto(String),
}

impl serde::Serialize for PageError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
