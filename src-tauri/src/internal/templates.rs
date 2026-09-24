// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Template Library — custom secret block templates synced across devices.

use serde::{Deserialize, Serialize};
use std::path::Path;

use super::store::InternalStore;

const FILENAME: &str = "templates.json";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TemplateLibrary {
    pub templates: Vec<SecretTemplate>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecretTemplate {
    /// Unique template ID
    pub id: String,
    /// Template name (e.g., "Server Login", "API Key", "Database")
    pub name: String,
    /// Template icon (emoji or identifier)
    pub icon: String,
    /// Field definitions
    pub fields: Vec<TemplateField>,
    /// How many times this template has been used
    pub use_count: u32,
    /// ISO 8601 timestamp of creation
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TemplateField {
    /// Field key (e.g., "hostname", "port", "username")
    pub key: String,
    /// Display label
    pub label: String,
    /// Field type: "text", "password", "url", "email", "number"
    pub field_type: String,
    /// Default value (optional)
    pub default_value: Option<String>,
    /// Whether this field is required
    pub required: bool,
}

/// Get all templates.
pub fn get_templates(vault_dir: &Path, master_key: &[u8]) -> Vec<SecretTemplate> {
    let lib: TemplateLibrary = InternalStore::read_sealed(vault_dir, FILENAME, master_key);
    lib.templates
}

/// Save a new template.
pub fn save_template(
    vault_dir: &Path,
    master_key: &[u8],
    template: &SecretTemplate,
) -> std::io::Result<()> {
    let mut lib: TemplateLibrary = InternalStore::read_sealed(vault_dir, FILENAME, master_key);

    // Update if exists, otherwise add
    if let Some(existing) = lib.templates.iter_mut().find(|t| t.id == template.id) {
        *existing = template.clone();
    } else {
        lib.templates.push(template.clone());
    }

    InternalStore::write_sealed(vault_dir, FILENAME, &lib, master_key)
}

/// Delete a template by ID.
pub fn delete_template(
    vault_dir: &Path,
    master_key: &[u8],
    template_id: &str,
) -> std::io::Result<()> {
    let mut lib: TemplateLibrary = InternalStore::read_sealed(vault_dir, FILENAME, master_key);
    lib.templates.retain(|t| t.id != template_id);
    InternalStore::write_sealed(vault_dir, FILENAME, &lib, master_key)
}

/// Increment the use count for a template.
pub fn increment_use_count(
    vault_dir: &Path,
    master_key: &[u8],
    template_id: &str,
) -> std::io::Result<()> {
    let mut lib: TemplateLibrary = InternalStore::read_sealed(vault_dir, FILENAME, master_key);
    if let Some(template) = lib.templates.iter_mut().find(|t| t.id == template_id) {
        template.use_count += 1;
    }
    InternalStore::write_sealed(vault_dir, FILENAME, &lib, master_key)
}
