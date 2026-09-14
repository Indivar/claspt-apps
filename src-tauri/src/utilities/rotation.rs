// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Rotation reminders: which stored passwords are older than the owner's
//! limit, and the security alerts that say so.
//!
//! Age comes from the generated-password history when the value was made
//! by Claspt's generator (the `generated` timestamp of the matching history
//! entry), else from the page's last update, which can only overstate how
//! fresh a password is. History pages and any block marked `url_match:
//! never` are never candidates themselves.

use std::collections::HashMap;
use std::path::Path;

use chrono::{DateTime, Utc};
use serde::Serialize;

use super::collect_all_pages;
use super::health::is_password_field;
use crate::internal::security_alerts::{self, SecurityAlert};
use crate::pages::error::PageError;
use crate::pages::secret::{decrypt_secrets, list_blocks};

/// Mirrors `HISTORY_FOLDER` / `HISTORY_TAG` in `shared/src/generated-history.ts`.
pub const HISTORY_FOLDER: &str = "Generated password history";
pub const HISTORY_TAG: &str = "generated-password-history";
pub const ALERT_TYPE: &str = "password_expiry";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RotationEntry {
    pub page_path: String,
    pub page_title: String,
    pub label: String,
    pub field: String,
    /// When the password is known to date from.
    pub since: DateTime<Utc>,
    pub age_days: i64,
    /// "generated" when the history dates it; "page_updated" otherwise.
    pub basis: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct RotationReport {
    pub max_age_days: u32,
    pub due: Vec<RotationEntry>,
}

fn is_history_page(meta: &crate::pages::model::PageMeta) -> bool {
    meta.folder == HISTORY_FOLDER || meta.tags.iter().any(|t| t == HISTORY_TAG)
}

/// Every stored password older than `max_age_days`, oldest first. A limit
/// of 0 means reminders are off and returns nothing.
pub fn rotation_due(
    vault_dir: &Path,
    master_key: &[u8],
    max_age_days: u32,
    now: DateTime<Utc>,
) -> Result<RotationReport, PageError> {
    let mut report = RotationReport {
        max_age_days,
        due: Vec::new(),
    };
    if max_age_days == 0 {
        return Ok(report);
    }
    let pages = collect_all_pages(vault_dir)?;

    // Generated value -> when it was generated (the latest, if repeated).
    let mut generated: HashMap<String, DateTime<Utc>> = HashMap::new();
    for (_, meta, content) in pages.iter().filter(|(_, m, _)| is_history_page(m)) {
        let Ok(decrypted) = decrypt_secrets(content, master_key) else {
            continue;
        };
        for (_, fields) in list_blocks(&decrypted) {
            let value = fields.iter().find(|(k, _)| k == "password").map(|(_, v)| v);
            let when = fields
                .iter()
                .find(|(k, _)| k == "generated")
                .and_then(|(_, v)| DateTime::parse_from_rfc3339(v).ok())
                .map(|d| d.with_timezone(&Utc))
                .unwrap_or(meta.updated_at);
            if let Some(value) = value {
                let slot = generated.entry(value.clone()).or_insert(when);
                if when > *slot {
                    *slot = when;
                }
            }
        }
    }

    for (rel_path, meta, content) in pages.iter().filter(|(_, m, _)| !is_history_page(m)) {
        if !content.contains(":::secret[") {
            continue;
        }
        let Ok(decrypted) = decrypt_secrets(content, master_key) else {
            continue;
        };
        for (label, fields) in list_blocks(&decrypted) {
            if fields
                .iter()
                .any(|(k, v)| k == "url_match" && v.trim().eq_ignore_ascii_case("never"))
            {
                continue;
            }
            for (field, value) in &fields {
                if !is_password_field(&field.to_lowercase()) || value.trim().is_empty() {
                    continue;
                }
                let (since, basis) = match generated.get(value) {
                    Some(when) => (*when, "generated"),
                    None => (meta.updated_at, "page_updated"),
                };
                let age_days = (now - since).num_days();
                if age_days >= i64::from(max_age_days) {
                    report.due.push(RotationEntry {
                        page_path: rel_path.clone(),
                        page_title: meta.title.clone(),
                        label: label.clone(),
                        field: field.clone(),
                        since,
                        age_days,
                        basis,
                    });
                }
            }
        }
    }
    report.due.sort_by(|a, b| {
        b.age_days
            .cmp(&a.age_days)
            .then(a.page_path.cmp(&b.page_path))
    });
    Ok(report)
}

/// Bring the `password_expiry` alerts in line with what is due: one alert per
/// (page, label) that stays until resolved or dismissed, and resolved on its
/// own once the password is no longer due (it was changed). Returns
/// (added, resolved).
pub fn refresh_alerts(
    vault_dir: &Path,
    master_key: &[u8],
    max_age_days: u32,
    now: DateTime<Utc>,
) -> Result<(usize, usize), PageError> {
    let report = rotation_due(vault_dir, master_key, max_age_days, now)?;
    let existing = security_alerts::get_alerts(vault_dir);
    let open: Vec<&SecurityAlert> = existing
        .iter()
        .filter(|a| a.alert_type == ALERT_TYPE && !a.resolved)
        .collect();
    let key_of = |page: &str, label: &str| format!("{page}\u{0}{label}");
    let due_keys: std::collections::HashSet<String> = report
        .due
        .iter()
        .map(|e| key_of(&e.page_path, &e.label))
        .collect();

    let mut resolved = 0;
    for alert in &open {
        let key = key_of(
            alert.page_path.as_deref().unwrap_or(""),
            alert.label.as_deref().unwrap_or(""),
        );
        if !due_keys.contains(&key) {
            security_alerts::resolve_alert(vault_dir, &alert.id)?;
            resolved += 1;
        }
    }

    let mut added = 0;
    let mut seen = std::collections::HashSet::new();
    for entry in &report.due {
        let key = key_of(&entry.page_path, &entry.label);
        if !seen.insert(key.clone()) {
            continue;
        }
        let already = open.iter().any(|a| {
            key_of(
                a.page_path.as_deref().unwrap_or(""),
                a.label.as_deref().unwrap_or(""),
            ) == key
        });
        if already {
            continue;
        }
        let how = match entry.basis {
            "generated" => "generated",
            _ => "last saved",
        };
        let alert = SecurityAlert::new(
            ALERT_TYPE,
            "medium",
            &format!("Rotate '{}' on {}", entry.label, entry.page_title),
            &format!(
                "The {} was {how} {} days ago ({}); your limit is {} days.",
                entry.field,
                entry.age_days,
                entry.since.format("%Y-%m-%d"),
                max_age_days
            ),
        )
        .for_credential(&entry.page_path, &entry.label);
        security_alerts::add_alert(vault_dir, &alert)?;
        added += 1;
    }
    Ok((added, resolved))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pages::model::{parse_page, serialize_page};
    use crate::pages::{agent_secret, crud};
    use chrono::Duration;
    use std::collections::BTreeMap;

    fn store(
        vault: &Path,
        key: &[u8],
        service: &str,
        label: &str,
        fields: &[(&str, &str)],
        tags: &[&str],
    ) -> String {
        let fields: BTreeMap<String, String> = fields
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        let tags: Vec<String> = tags.iter().map(|t| t.to_string()).collect();
        agent_secret::store_secret(vault, service, label, &fields, &tags, "test", key)
            .unwrap()
            .page
            .path
    }

    fn age_page(vault: &Path, rel: &str, now: DateTime<Utc>, days: i64) {
        let full = vault.join(rel);
        let raw = std::fs::read_to_string(&full).unwrap();
        let (mut meta, content) = parse_page(&raw).unwrap();
        meta.updated_at = now - Duration::days(days);
        std::fs::write(&full, serialize_page(&meta, &content).unwrap()).unwrap();
    }

    #[test]
    fn age_comes_from_history_when_known_and_the_page_otherwise() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        let key = [3u8; 32];
        let now = Utc::now();
        let old_when = (now - Duration::days(400)).to_rfc3339();
        let new_when = (now - Duration::days(5)).to_rfc3339();
        // History: one old generated value, one fresh one.
        let history = store(
            vault,
            &key,
            "history",
            "example.com — 1 Jan 10:00:00",
            &[
                ("password", "OLD-GEN"),
                ("generated", &old_when),
                ("url_match", "never"),
            ],
            &[HISTORY_TAG],
        );
        store(
            vault,
            &key,
            "history",
            "example.com — 2 Jan 10:00:00",
            &[
                ("password", "NEW-GEN"),
                ("generated", &new_when),
                ("url_match", "never"),
            ],
            &[HISTORY_TAG],
        );
        // Credentials: old generated, fresh generated, unknown on an old page,
        // unknown on a fresh page, and a never-match block on an old page.
        store(
            vault,
            &key,
            "shop",
            "Shop",
            &[("username", "u"), ("password", "OLD-GEN")],
            &[],
        );
        store(vault, &key, "mail", "Mail", &[("password", "NEW-GEN")], &[]);
        let unknown_old = store(
            vault,
            &key,
            "bank",
            "Bank",
            &[("api_key", "hand-typed")],
            &[],
        );
        age_page(vault, &unknown_old, now, 200);
        store(
            vault,
            &key,
            "fresh",
            "Fresh",
            &[("password", "typed-today")],
            &[],
        );
        let never = store(
            vault,
            &key,
            "scratch",
            "Scratch",
            &[("password", "x"), ("url_match", "never")],
            &[],
        );
        age_page(vault, &never, now, 900);
        // The history page itself is ancient but never a candidate.
        age_page(vault, &history, now, 900);

        let report = rotation_due(vault, &key, 180, now).unwrap();
        let summary: Vec<(&str, &str, i64)> = report
            .due
            .iter()
            .map(|e| (e.label.as_str(), e.basis, e.age_days))
            .collect();
        assert_eq!(
            summary,
            [("Shop", "generated", 400), ("Bank", "page_updated", 200)]
        );
        assert_eq!(report.due[0].field, "password");
        assert_eq!(report.due[1].field, "api_key");
        assert!(rotation_due(vault, &key, 0, now).unwrap().due.is_empty());
        assert!(rotation_due(vault, &key, 500, now).unwrap().due.is_empty());
    }

    #[test]
    fn alerts_are_added_once_and_resolved_when_the_password_changes() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        let key = [3u8; 32];
        let now = Utc::now();
        let shop = store(vault, &key, "shop", "Shop", &[("password", "stale")], &[]);
        age_page(vault, &shop, now, 300);
        assert_eq!(refresh_alerts(vault, &key, 180, now).unwrap(), (1, 0));
        // A second pass adds nothing; a dismissed alert still counts as raised.
        assert_eq!(refresh_alerts(vault, &key, 180, now).unwrap(), (0, 0));
        let alert = security_alerts::get_active_alerts(vault)
            .into_iter()
            .next()
            .unwrap();
        assert_eq!(alert.alert_type, ALERT_TYPE);
        assert_eq!(alert.page_path.as_deref(), Some(shop.as_str()));
        assert!(alert.description.contains("300 days"));
        security_alerts::dismiss_alert(vault, &alert.id).unwrap();
        assert_eq!(refresh_alerts(vault, &key, 180, now).unwrap(), (0, 0));
        // Changing the password (a fresh save) resolves it.
        store(vault, &key, "shop", "Shop", &[("password", "rotated")], &[]);
        assert_eq!(refresh_alerts(vault, &key, 180, now).unwrap(), (0, 1));
        assert!(security_alerts::get_alerts(vault)
            .iter()
            .all(|a| a.resolved));
        // Turned off: nothing raised, nothing touched.
        assert_eq!(refresh_alerts(vault, &key, 0, now).unwrap(), (0, 0));
        // Ensure the vault read path did not trip on the page that changed.
        assert!(crud::read_page(vault, &shop).is_ok());
    }
}
