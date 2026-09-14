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
pub fn get_templates(vault_dir: &Path) -> Vec<SecretTemplate> {
    let lib: TemplateLibrary = InternalStore::read(vault_dir, FILENAME);
    lib.templates
}

/// Save a new template.
pub fn save_template(vault_dir: &Path, template: &SecretTemplate) -> std::io::Result<()> {
    let mut lib: TemplateLibrary = InternalStore::read(vault_dir, FILENAME);

    // Update if exists, otherwise add
    if let Some(existing) = lib.templates.iter_mut().find(|t| t.id == template.id) {
        *existing = template.clone();
    } else {
        lib.templates.push(template.clone());
    }

    InternalStore::write(vault_dir, FILENAME, &lib)
}

/// Delete a template by ID.
pub fn delete_template(vault_dir: &Path, template_id: &str) -> std::io::Result<()> {
    let mut lib: TemplateLibrary = InternalStore::read(vault_dir, FILENAME);
    lib.templates.retain(|t| t.id != template_id);
    InternalStore::write(vault_dir, FILENAME, &lib)
}

/// Increment the use count for a template.
pub fn increment_use_count(vault_dir: &Path, template_id: &str) -> std::io::Result<()> {
    let mut lib: TemplateLibrary = InternalStore::read(vault_dir, FILENAME);
    if let Some(template) = lib.templates.iter_mut().find(|t| t.id == template_id) {
        template.use_count += 1;
    }
    InternalStore::write(vault_dir, FILENAME, &lib)
}

/// Get built-in default templates (not stored, always available).
pub fn default_templates() -> Vec<SecretTemplate> {
    vec![
        SecretTemplate {
            id: "builtin-login".to_string(),
            name: "Login".to_string(),
            icon: "🔑".to_string(),
            fields: vec![
                TemplateField {
                    key: "username".into(),
                    label: "Username".into(),
                    field_type: "text".into(),
                    default_value: None,
                    required: true,
                },
                TemplateField {
                    key: "password".into(),
                    label: "Password".into(),
                    field_type: "password".into(),
                    default_value: None,
                    required: true,
                },
                TemplateField {
                    key: "url".into(),
                    label: "URL".into(),
                    field_type: "url".into(),
                    default_value: None,
                    required: false,
                },
            ],
            use_count: 0,
            created_at: String::new(),
        },
        SecretTemplate {
            id: "builtin-api-key".to_string(),
            name: "API Key".to_string(),
            icon: "⚡".to_string(),
            fields: vec![
                TemplateField {
                    key: "service".into(),
                    label: "Service".into(),
                    field_type: "text".into(),
                    default_value: None,
                    required: true,
                },
                TemplateField {
                    key: "key".into(),
                    label: "API Key".into(),
                    field_type: "password".into(),
                    default_value: None,
                    required: true,
                },
                TemplateField {
                    key: "secret".into(),
                    label: "API Secret".into(),
                    field_type: "password".into(),
                    default_value: None,
                    required: false,
                },
                TemplateField {
                    key: "url".into(),
                    label: "Endpoint URL".into(),
                    field_type: "url".into(),
                    default_value: None,
                    required: false,
                },
            ],
            use_count: 0,
            created_at: String::new(),
        },
        SecretTemplate {
            id: "builtin-server".to_string(),
            name: "Server".to_string(),
            icon: "🖥️".to_string(),
            fields: vec![
                TemplateField {
                    key: "hostname".into(),
                    label: "Hostname".into(),
                    field_type: "text".into(),
                    default_value: None,
                    required: true,
                },
                TemplateField {
                    key: "port".into(),
                    label: "Port".into(),
                    field_type: "number".into(),
                    default_value: Some("22".into()),
                    required: false,
                },
                TemplateField {
                    key: "username".into(),
                    label: "Username".into(),
                    field_type: "text".into(),
                    default_value: Some("root".into()),
                    required: true,
                },
                TemplateField {
                    key: "password".into(),
                    label: "Password".into(),
                    field_type: "password".into(),
                    default_value: None,
                    required: false,
                },
                TemplateField {
                    key: "ssh_key".into(),
                    label: "SSH Key".into(),
                    field_type: "password".into(),
                    default_value: None,
                    required: false,
                },
            ],
            use_count: 0,
            created_at: String::new(),
        },
        SecretTemplate {
            id: "builtin-database".to_string(),
            name: "Database".to_string(),
            icon: "🗄️".to_string(),
            fields: vec![
                TemplateField {
                    key: "host".into(),
                    label: "Host".into(),
                    field_type: "text".into(),
                    default_value: Some("localhost".into()),
                    required: true,
                },
                TemplateField {
                    key: "port".into(),
                    label: "Port".into(),
                    field_type: "number".into(),
                    default_value: Some("5432".into()),
                    required: false,
                },
                TemplateField {
                    key: "database".into(),
                    label: "Database".into(),
                    field_type: "text".into(),
                    default_value: None,
                    required: true,
                },
                TemplateField {
                    key: "username".into(),
                    label: "Username".into(),
                    field_type: "text".into(),
                    default_value: None,
                    required: true,
                },
                TemplateField {
                    key: "password".into(),
                    label: "Password".into(),
                    field_type: "password".into(),
                    default_value: None,
                    required: true,
                },
                TemplateField {
                    key: "connection_string".into(),
                    label: "Connection String".into(),
                    field_type: "password".into(),
                    default_value: None,
                    required: false,
                },
            ],
            use_count: 0,
            created_at: String::new(),
        },
        SecretTemplate {
            id: "builtin-credit-card".to_string(),
            name: "Credit Card".to_string(),
            icon: "💳".to_string(),
            fields: vec![
                TemplateField {
                    key: "card_name".into(),
                    label: "Cardholder Name".into(),
                    field_type: "text".into(),
                    default_value: None,
                    required: true,
                },
                TemplateField {
                    key: "card_number".into(),
                    label: "Card Number".into(),
                    field_type: "password".into(),
                    default_value: None,
                    required: true,
                },
                TemplateField {
                    key: "expiry".into(),
                    label: "Expiry (MM/YY)".into(),
                    field_type: "text".into(),
                    default_value: None,
                    required: true,
                },
                TemplateField {
                    key: "cvv".into(),
                    label: "CVV".into(),
                    field_type: "password".into(),
                    default_value: None,
                    required: true,
                },
                TemplateField {
                    key: "billing_zip".into(),
                    label: "Billing ZIP".into(),
                    field_type: "text".into(),
                    default_value: None,
                    required: false,
                },
            ],
            use_count: 0,
            created_at: String::new(),
        },
    ]
}
