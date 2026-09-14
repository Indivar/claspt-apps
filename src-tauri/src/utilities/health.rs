// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Password-health audit across the whole vault.
//!
//! Decrypts every secret block, extracts password-like fields, scores each with
//! the strength estimator ([`crate::generator::strength`]), and flags passwords
//! reused across entries (matched on the exact value). Produces per-password
//! entries plus a summary bucketed by strength score, so the UI can show a
//! security overview.

use super::collect_all_pages;
use crate::generator::strength;
use crate::pages::error::PageError;
use crate::pages::secret::decrypt_secrets;
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;

/// Strength assessment of one stored password.
#[derive(Debug, Serialize)]
pub struct PasswordHealthEntry {
    /// Title of the page holding the password.
    pub page_title: String,
    /// Vault-relative path of that page.
    pub page_path: String,
    /// Secret block label the password came from.
    pub label: String,
    /// Strength score, 0 (very weak) to 4 (very strong).
    pub score: u8,
    /// Human-readable strength label (e.g. "Weak", "Strong").
    pub label_text: String,
    /// Estimated offline crack time, human-readable.
    pub crack_time: String,
    /// Estimated entropy in bits.
    pub entropy_bits: f64,
    /// Whether this exact password value appears on more than one entry.
    pub reused: bool,
}

/// Aggregate counts across all analyzed passwords.
#[derive(Debug, Serialize)]
pub struct HealthSummary {
    /// Total passwords analyzed.
    pub total: usize,
    /// Count of passwords per strength score (0–4).
    pub by_score: HashMap<u8, usize>,
    /// Number of entries that share a reused password value.
    pub reused_count: usize,
}

/// Full password-health report: per-password entries plus the summary.
#[derive(Debug, Serialize)]
pub struct PasswordHealthReport {
    /// One entry per password value found.
    pub entries: Vec<PasswordHealthEntry>,
    /// Aggregate statistics over `entries`.
    pub summary: HealthSummary,
}

/// Extract password-like fields from a decrypted secret block content.
/// Looks for lines like "password: value", "pass: value", "key: value", etc.
/// Field names whose values are treated as passwords or secrets by the
/// health report and the rotation reminders. One list, so both agree.
pub(crate) fn is_password_field(key_lower: &str) -> bool {
    matches!(
        key_lower,
        "password" | "pass" | "pwd" | "secret" | "key" | "api_key" | "api-key" | "apikey" | "token"
    )
}

fn extract_passwords_from_block(block_content: &str) -> Vec<(String, String)> {
    let mut passwords = Vec::new();

    // If it's a single-line block (just a password value), treat the whole thing as a password
    let lines: Vec<&str> = block_content.lines().collect();
    if lines.len() == 1 && !lines[0].contains(':') {
        let val = lines[0].trim();
        if !val.is_empty() {
            passwords.push(("value".to_string(), val.to_string()));
        }
        return passwords;
    }

    for line in lines {
        if let Some((key, value)) = line.split_once(':') {
            let key_lower = key.trim().to_lowercase();
            let val = value.trim().to_string();
            if val.is_empty() {
                continue;
            }
            // Match password-related field names
            if is_password_field(&key_lower) {
                passwords.push((key.trim().to_string(), val));
            }
        }
    }
    passwords
}

/// Parse decrypted content to find secret blocks and extract passwords.
fn extract_secrets_with_passwords(decrypted_content: &str) -> Vec<(String, Vec<(String, String)>)> {
    let mut results = Vec::new();
    let mut in_secret = false;
    let mut current_label = String::new();
    let mut block_content = String::new();
    let mut in_code_fence = false;

    for line in decrypted_content.lines() {
        let trimmed = line.trim();

        // Track code fences
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_code_fence = !in_code_fence;
            continue;
        }
        if in_code_fence {
            continue;
        }

        if trimmed.starts_with(":::secret[") && trimmed.contains(']') {
            let label_start = ":::secret[".len();
            if let Some(label_end) = trimmed[label_start..].find(']') {
                current_label = trimmed[label_start..label_start + label_end].to_string();
                block_content.clear();
                in_secret = true;
            }
        } else if in_secret && trimmed == ":::" {
            let passwords = extract_passwords_from_block(&block_content);
            if !passwords.is_empty() {
                results.push((current_label.clone(), passwords));
            }
            in_secret = false;
        } else if in_secret {
            if !block_content.is_empty() {
                block_content.push('\n');
            }
            block_content.push_str(line);
        }
    }
    results
}

/// Analyze the strength and reuse of every password stored in the vault.
/// `master_key` decrypts secret blocks in memory; pages that fail to decrypt
/// are skipped rather than erroring.
pub fn password_health(
    vault_dir: &Path,
    master_key: &[u8],
) -> Result<PasswordHealthReport, PageError> {
    let pages = collect_all_pages(vault_dir)?;
    let mut entries = Vec::new();
    // Track password hashes for reuse detection
    let mut password_hash_map: HashMap<String, Vec<usize>> = HashMap::new();

    for (rel_path, meta, content) in &pages {
        // Skip pages without secret blocks
        if !content.contains(":::secret[") {
            continue;
        }

        // Decrypt the page content
        let decrypted = match decrypt_secrets(content, master_key) {
            Ok(d) => d,
            Err(_) => continue, // Skip pages that fail to decrypt
        };

        let secrets = extract_secrets_with_passwords(&decrypted);
        for (label, passwords) in secrets {
            for (_field_name, password_value) in &passwords {
                let result = strength::analyze(password_value);
                let entry_idx = entries.len();

                // Track for reuse detection (use password value as key)
                password_hash_map
                    .entry(password_value.clone())
                    .or_default()
                    .push(entry_idx);

                entries.push(PasswordHealthEntry {
                    page_title: meta.title.clone(),
                    page_path: rel_path.clone(),
                    label: label.clone(),
                    score: result.score,
                    label_text: result.label.clone(),
                    crack_time: result.crack_time_display.clone(),
                    entropy_bits: result.entropy_bits,
                    reused: false, // Will be set below
                });
            }
        }
    }

    // Mark reused passwords
    let mut reused_count = 0;
    for indices in password_hash_map.values() {
        if indices.len() > 1 {
            for &idx in indices {
                entries[idx].reused = true;
            }
            reused_count += indices.len();
        }
    }

    // Build summary
    let mut by_score: HashMap<u8, usize> = HashMap::new();
    for entry in &entries {
        *by_score.entry(entry.score).or_default() += 1;
    }

    let summary = HealthSummary {
        total: entries.len(),
        by_score,
        reused_count,
    };

    Ok(PasswordHealthReport { entries, summary })
}
