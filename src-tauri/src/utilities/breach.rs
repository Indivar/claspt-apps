// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Breach checking of stored passwords via Have I Been Pwned.
//!
//! Uses the HIBP "range" API with k-anonymity: only the first 5 hex characters
//! of a password's SHA-1 hash are sent to the server, which returns all hash
//! suffixes sharing that prefix along with their breach counts. The full hash
//! never leaves the device. Passwords are extracted from decrypted secret
//! blocks, de-duplicated in a cache to avoid repeat lookups, and any with a
//! non-zero breach count are reported.

use super::collect_all_pages;
use crate::pages::error::PageError;
use crate::pages::secret::decrypt_secrets;
use ring::digest;
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;

/// One stored password found in a public breach corpus.
#[derive(Debug, Serialize)]
pub struct BreachEntry {
    /// Title of the page holding the breached secret.
    pub page_title: String,
    /// Vault-relative path of that page.
    pub page_path: String,
    /// Label of the secret block the password came from.
    pub label: String,
    /// Number of times HIBP has seen this password across breaches.
    pub breach_count: u64,
}

/// Summary of a full-vault breach check.
#[derive(Debug, Serialize)]
pub struct BreachCheckReport {
    /// Every breached password found (one per occurrence).
    pub entries: Vec<BreachEntry>,
    /// Total number of password values checked against HIBP.
    pub total_checked: usize,
    /// How many of those were found in a breach (== `entries.len()`).
    pub total_breached: usize,
}

/// SHA-1 hash a password and return uppercase hex string.
fn sha1_hex(password: &str) -> String {
    let hash = digest::digest(&digest::SHA1_FOR_LEGACY_USE_ONLY, password.as_bytes());
    hash.as_ref().iter().map(|b| format!("{:02X}", b)).collect()
}

/// Check a single password against HIBP k-anonymity API.
fn check_hibp(password: &str) -> Result<u64, PageError> {
    let hash = sha1_hex(password);
    let prefix = &hash[..5];
    let suffix = &hash[5..];

    let url = format!("https://api.pwnedpasswords.com/range/{}", prefix);
    let response = reqwest::blocking::Client::new()
        .get(&url)
        .header("User-Agent", "Claspt-VaultUtility")
        .send()
        .map_err(|e| PageError::Crypto(format!("HIBP request failed: {e}")))?;

    let body = response
        .text()
        .map_err(|e| PageError::Crypto(format!("HIBP response read failed: {e}")))?;

    for line in body.lines() {
        if let Some((hash_suffix, count_str)) = line.split_once(':') {
            if hash_suffix.trim().eq_ignore_ascii_case(suffix) {
                return count_str
                    .trim()
                    .parse::<u64>()
                    .map_err(|e| PageError::Crypto(format!("HIBP count parse error: {e}")));
            }
        }
    }

    Ok(0)
}

/// Extract password values from decrypted content.
fn extract_password_values(decrypted_content: &str) -> Vec<(String, String)> {
    let mut results = Vec::new();
    let mut in_secret = false;
    let mut current_label = String::new();
    let mut block_content = String::new();
    let mut in_code_fence = false;

    for line in decrypted_content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_code_fence = !in_code_fence;
            continue;
        }
        if in_code_fence {
            continue;
        }

        if trimmed.starts_with(":::secret[") && trimmed.contains(']') {
            let start = ":::secret[".len();
            if let Some(end) = trimmed[start..].find(']') {
                current_label = trimmed[start..start + end].to_string();
                block_content.clear();
                in_secret = true;
            }
        } else if in_secret && trimmed == ":::" {
            // Extract password fields
            let lines: Vec<&str> = block_content.lines().collect();
            if lines.len() == 1 && !lines[0].contains(':') {
                let val = lines[0].trim();
                if !val.is_empty() {
                    results.push((current_label.clone(), val.to_string()));
                }
            } else {
                for bl in block_content.lines() {
                    if let Some((key, value)) = bl.split_once(':') {
                        let k = key.trim().to_lowercase();
                        let v = value.trim().to_string();
                        if !v.is_empty()
                            && (k == "password"
                                || k == "pass"
                                || k == "pwd"
                                || k == "secret"
                                || k == "key"
                                || k == "token"
                                || k == "api_key"
                                || k == "apikey"
                                || k == "api-key")
                        {
                            results.push((current_label.clone(), v));
                        }
                    }
                }
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

/// Scan every secret block in the vault and report passwords found in known
/// breaches. `master_key` is needed to decrypt secret blocks in memory; pages
/// that fail to decrypt are skipped. Returns an error only if the HIBP request
/// itself fails.
pub fn breach_check(vault_dir: &Path, master_key: &[u8]) -> Result<BreachCheckReport, PageError> {
    let pages = collect_all_pages(vault_dir)?;
    let mut entries = Vec::new();
    let mut total_checked = 0;
    // Cache: avoid checking the same password twice
    let mut checked_cache: HashMap<String, u64> = HashMap::new();

    for (rel_path, meta, content) in &pages {
        if !content.contains(":::secret[") {
            continue;
        }

        let decrypted = match decrypt_secrets(content, master_key) {
            Ok(d) => d,
            Err(_) => continue,
        };

        let passwords = extract_password_values(&decrypted);
        for (label, password_value) in passwords {
            total_checked += 1;

            let breach_count = if let Some(&cached) = checked_cache.get(&password_value) {
                cached
            } else {
                let count = check_hibp(&password_value)?;
                checked_cache.insert(password_value.clone(), count);
                count
            };

            if breach_count > 0 {
                entries.push(BreachEntry {
                    page_title: meta.title.clone(),
                    page_path: rel_path.clone(),
                    label,
                    breach_count,
                });
            }
        }
    }

    let total_breached = entries.len();
    Ok(BreachCheckReport {
        entries,
        total_checked,
        total_breached,
    })
}
