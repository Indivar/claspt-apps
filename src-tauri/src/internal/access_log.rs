// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Append-only log of every local API request: who asked, for what, and what
//! happened.
//!
//! The API is how agents reach the vault, and until now nothing recorded
//! their reads. A secrets-scope client could decrypt every credential and
//! leave no trace; a burst of bad tokens looked like nothing at all. This log
//! is the record: one line per request with the client's identity, the action
//! (derived from the route, never from the body), the target path, the
//! status, and how long it took. Values are never logged: the target is a page
//! path or a memory title, and the query string is dropped because search
//! terms and labels have no business in a log.
//!
//! Format is JSON Lines, one object per line, appended in place, because the
//! log grows by hundreds of lines in an agent session and rewriting a JSON
//! array each time (what `InternalStore::append` does for the small journals)
//! would make every request slower than the last. There is one file per
//! calendar month, `access-YYYY-MM.jsonl`, so "what happened in August" is one
//! file and "what happened lately" only opens the current one. Months older
//! than the vault's retention setting (12 by default, adjustable in Settings)
//! are deleted when a new month's file is first created. All of it lives in
//! `.securenotes/internal/access/`, owner-only, excluded from git and sync
//! with the rest of that directory.
//!
//! Reads skip a line that does not parse instead of failing: a truncated tail
//! from a crash mid-write must not hide the thousands of good lines before it.

use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::store::InternalStore;
use crate::local_api::auth::TokenScope;

const SUBDIR: &str = "access";
const PREFIX: &str = "access-";
const SUFFIX: &str = ".jsonl";
/// Months kept when the vault config does not say otherwise.
pub const DEFAULT_RETENTION_MONTHS: u32 = 12;

/// One request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccessEntry {
    pub ts: DateTime<Utc>,
    /// Empty for a request that failed authentication.
    pub client_id: String,
    pub client_name: String,
    pub scope: Option<TokenScope>,
    /// Route-derived verb, see [`action_for`].
    pub action: String,
    pub method: String,
    /// The request path, URL-decoded, without the query string.
    pub target: String,
    pub status: u16,
    pub duration_ms: u64,
}

/// The verb a request performed, from its method and path alone.
///
/// Derived from the route table, not from the body, so it can be assigned to a
/// request before the handler runs and cannot be influenced by what a client
/// sends. `secret.read` is the route that returns decrypted values; a
/// `page.read` by a Secrets-scope client also decrypts the blocks on that
/// page, which is why the scope is logged beside the action.
pub fn action_for(method: &str, path: &str) -> &'static str {
    let segments: Vec<&str> = path
        .trim_start_matches('/')
        .split('/')
        .filter(|s| !s.is_empty())
        .collect();
    let rest = match segments.as_slice() {
        ["api", rest @ ..] => rest,
        _ => return "other",
    };
    match (method, rest) {
        ("GET", ["status"]) => "status",
        ("POST", ["pair"]) => "pair",
        ("GET", ["pages"]) => "page.list",
        ("POST", ["pages"]) => "page.create",
        ("GET", ["pages", _]) => "page.read",
        ("PUT", ["pages", _]) => "page.write",
        ("DELETE", ["pages", _]) => "page.delete",
        ("GET", ["pages", _, "secret"]) => "secret.read",
        ("PATCH", ["pages", _, "secret"]) => "secret.write",
        ("DELETE", ["pages", _, "secret"]) => "secret.delete",
        ("PATCH", ["pages", _, "secret", "rename"]) => "secret.rename",
        ("PATCH", ["pages", _, _]) => "page.update",
        ("GET", ["search"]) => "search",
        ("GET", ["folders"]) => "folder.list",
        ("POST", ["folders"]) => "folder.create",
        ("PATCH", ["folders", _]) => "folder.rename",
        ("DELETE", ["folders", _]) => "folder.delete",
        (_, ["generate", ..]) => "generate",
        ("GET", ["memory"]) | ("GET", ["memory", _]) => "memory.list",
        ("POST", ["memory", "cleanup"]) => "memory.cleanup",
        ("PUT", ["memory", _]) => "memory.write",
        ("POST", ["memory", _, "bulk"]) => "memory.write",
        ("POST", ["memory", _, "bootstrap"]) => "memory.bootstrap",
        ("GET", ["memory", _, _]) => "memory.read",
        ("DELETE", ["memory", _, _]) => "memory.delete",
        ("POST", ["memory", _, _, "append"]) => "memory.write",
        ("GET", ["secrets"]) => "secret.list",
        ("POST", ["secrets"]) => "secret.store",
        ("GET", ["audit", ..]) => "audit",
        ("GET", ["ssh", "identities"]) => "ssh.list",
        ("GET", ["passkeys"]) => "passkey.list",
        ("POST", ["passkeys", _, "register"]) => "passkey.register",
        ("POST", ["passkeys", _, "authenticate"]) => "passkey.authenticate",
        ("POST", ["browser", "login", _]) => "browser.login",
        ("GET", ["browser", "login", _]) => "browser.login.status",
        (_, ["browser", "jobs", ..]) => "browser.jobs",
        _ => "other",
    }
}

fn log_dir(vault_dir: &Path) -> PathBuf {
    InternalStore::dir(vault_dir).join(SUBDIR)
}

/// `YYYY-MM` for an entry's timestamp.
fn month_of(ts: &DateTime<Utc>) -> String {
    ts.format("%Y-%m").to_string()
}

fn month_file(vault_dir: &Path, month: &str) -> PathBuf {
    log_dir(vault_dir).join(format!("{PREFIX}{month}{SUFFIX}"))
}

/// The months that have a file, newest first.
pub fn list_months(vault_dir: &Path) -> std::io::Result<Vec<String>> {
    let mut months = Vec::new();
    let dir = match std::fs::read_dir(log_dir(vault_dir)) {
        Ok(d) => d,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(months),
        Err(e) => return Err(e),
    };
    for entry in dir.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if let Some(month) = name
            .strip_prefix(PREFIX)
            .and_then(|rest| rest.strip_suffix(SUFFIX))
        {
            if month.len() == 7 && month.as_bytes()[4] == b'-' {
                months.push(month.to_string());
            }
        }
    }
    // Lexicographic order is chronological for YYYY-MM.
    months.sort();
    months.reverse();
    Ok(months)
}

/// Append one entry to its month's file. Never returns an error the request
/// should care about; the caller logs and continues, since a full disk must
/// not make the vault unusable. Retention comes from the vault config.
pub fn record(vault_dir: &Path, entry: &AccessEntry) -> std::io::Result<()> {
    let retention = crate::vault::init::read_config(vault_dir)
        .map(|c| c.access_log_retention_months)
        .unwrap_or(DEFAULT_RETENTION_MONTHS);
    record_with_retention(vault_dir, entry, retention)
}

/// [`record`] with an explicit retention, for callers that already know it.
pub fn record_with_retention(
    vault_dir: &Path,
    entry: &AccessEntry,
    retention_months: u32,
) -> std::io::Result<()> {
    InternalStore::ensure_dir(vault_dir)?;
    let dir = log_dir(vault_dir);
    if !dir.exists() {
        std::fs::create_dir_all(&dir)?;
        claspt_core::fs_perms::restrict_to_owner(&dir)?;
    }
    let path = month_file(vault_dir, &month_of(&entry.ts));
    let created = !path.exists();
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?;
    if created {
        claspt_core::fs_perms::restrict_to_owner(&path)?;
        // A new month is the one moment worth listing the directory: prune
        // what has fallen outside the retention window.
        prune(vault_dir, retention_months)?;
    }
    let mut line = serde_json::to_string(entry).map_err(std::io::Error::other)?;
    line.push('\n');
    file.write_all(line.as_bytes())
}

/// Delete every month file beyond the newest `retention_months`.
fn prune(vault_dir: &Path, retention_months: u32) -> std::io::Result<()> {
    let keep = retention_months.max(1) as usize;
    for month in list_months(vault_dir)?.into_iter().skip(keep) {
        std::fs::remove_file(month_file(vault_dir, &month))?;
    }
    Ok(())
}

fn read_file(path: &Path, client_id: Option<&str>) -> std::io::Result<Vec<AccessEntry>> {
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    Ok(std::io::BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .filter_map(|line| serde_json::from_str::<AccessEntry>(&line).ok())
        .filter(|e| match client_id {
            Some(id) => e.client_id == id,
            None => true,
        })
        .collect())
}

/// Everything recorded in one month (`YYYY-MM`), newest first.
pub fn read_month(
    vault_dir: &Path,
    month: &str,
    client_id: Option<&str>,
) -> std::io::Result<Vec<AccessEntry>> {
    let mut entries = read_file(&month_file(vault_dir, month), client_id)?;
    entries.reverse();
    Ok(entries)
}

/// The most recent `limit` entries, newest first, optionally for one client.
/// Walks months from the current one backwards until `limit` is satisfied.
pub fn read_recent(
    vault_dir: &Path,
    limit: usize,
    client_id: Option<&str>,
) -> std::io::Result<Vec<AccessEntry>> {
    let mut entries: Vec<AccessEntry> = Vec::new();
    for month in list_months(vault_dir)? {
        entries.extend(read_month(vault_dir, &month, client_id)?);
        if entries.len() >= limit {
            break;
        }
    }
    entries.truncate(limit);
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(client: &str, action: &str, status: u16) -> AccessEntry {
        AccessEntry {
            ts: Utc::now(),
            client_id: client.to_string(),
            client_name: format!("{client} name"),
            scope: Some(TokenScope::Secrets),
            action: action.to_string(),
            method: "GET".to_string(),
            target: "/api/pages/general/x.md/secret".to_string(),
            status,
            duration_ms: 3,
        }
    }

    #[test]
    fn actions_are_derived_from_method_and_route() {
        let cases = [
            ("GET", "/api/status", "status"),
            ("GET", "/api/pages", "page.list"),
            ("POST", "/api/pages", "page.create"),
            ("GET", "/api/pages/general%2Fx.md", "page.read"),
            ("PUT", "/api/pages/general%2Fx.md", "page.write"),
            ("DELETE", "/api/pages/general%2Fx.md", "page.delete"),
            ("GET", "/api/pages/general%2Fx.md/secret", "secret.read"),
            ("PATCH", "/api/pages/general%2Fx.md/secret", "secret.write"),
            (
                "DELETE",
                "/api/pages/general%2Fx.md/secret",
                "secret.delete",
            ),
            (
                "PATCH",
                "/api/pages/general%2Fx.md/secret/rename",
                "secret.rename",
            ),
            ("PATCH", "/api/pages/general%2Fx.md/move", "page.update"),
            ("GET", "/api/search", "search"),
            ("POST", "/api/generate/password", "generate"),
            ("GET", "/api/memory", "memory.list"),
            ("GET", "/api/memory/claspt", "memory.list"),
            ("PUT", "/api/memory/claspt", "memory.write"),
            ("POST", "/api/memory/claspt/bulk", "memory.write"),
            ("POST", "/api/memory/claspt/bootstrap", "memory.bootstrap"),
            ("GET", "/api/memory/claspt/decisions", "memory.read"),
            ("DELETE", "/api/memory/claspt/decisions", "memory.delete"),
            (
                "POST",
                "/api/memory/claspt/session-log/append",
                "memory.write",
            ),
            ("POST", "/api/memory/cleanup", "memory.cleanup"),
            ("GET", "/api/secrets", "secret.list"),
            ("POST", "/api/secrets", "secret.store"),
            ("GET", "/api/audit/secrets", "audit"),
            ("POST", "/api/pair", "pair"),
            ("GET", "/not-api", "other"),
            ("TRACE", "/api/pages", "other"),
        ];
        for (method, path, want) in cases {
            assert_eq!(action_for(method, path), want, "{method} {path}");
        }
    }

    #[test]
    fn entries_come_back_newest_first_filtered_and_limited() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        for i in 0..5 {
            let client = if i % 2 == 0 { "a" } else { "b" };
            record(vault, &entry(client, &format!("act{i}"), 200)).unwrap();
        }
        let all = read_recent(vault, 10, None).unwrap();
        assert_eq!(all.len(), 5);
        assert_eq!(all[0].action, "act4", "newest first");
        assert_eq!(all[4].action, "act0");

        let only_a = read_recent(vault, 10, Some("a")).unwrap();
        assert_eq!(
            only_a.iter().map(|e| e.action.as_str()).collect::<Vec<_>>(),
            ["act4", "act2", "act0"]
        );

        let limited = read_recent(vault, 2, None).unwrap();
        assert_eq!(limited.len(), 2);
        assert_eq!(limited[0].action, "act4");
    }

    fn entry_in(month: &str, client: &str, action: &str) -> AccessEntry {
        let ts = DateTime::parse_from_rfc3339(&format!("{month}-15T12:00:00Z"))
            .unwrap()
            .with_timezone(&Utc);
        AccessEntry {
            ts,
            ..entry(client, action, 200)
        }
    }

    #[test]
    fn entries_land_in_their_month_and_reads_walk_months_newest_first() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        record_with_retention(vault, &entry_in("2026-07", "a", "july"), 12).unwrap();
        record_with_retention(vault, &entry_in("2026-09", "a", "september"), 12).unwrap();
        record_with_retention(vault, &entry_in("2026-08", "a", "august"), 12).unwrap();

        assert_eq!(
            list_months(vault).unwrap(),
            ["2026-09", "2026-08", "2026-07"]
        );
        assert_eq!(
            read_month(vault, "2026-08", None).unwrap()[0].action,
            "august"
        );
        let recent = read_recent(vault, 2, None).unwrap();
        assert_eq!(
            recent.iter().map(|e| e.action.as_str()).collect::<Vec<_>>(),
            ["september", "august"]
        );
        assert!(read_month(vault, "2025-01", None).unwrap().is_empty());
    }

    #[test]
    fn months_beyond_retention_are_pruned_when_a_new_month_starts() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        for m in ["2026-01", "2026-02", "2026-03"] {
            record_with_retention(vault, &entry_in(m, "a", m), 2).unwrap();
        }
        // Creating March pruned January: two months are kept.
        assert_eq!(list_months(vault).unwrap(), ["2026-03", "2026-02"]);
        // Appending within an existing month never prunes, so a retention of
        // one applied to an old entry does not delete the current month.
        record_with_retention(vault, &entry_in("2026-03", "a", "again"), 1).unwrap();
        assert_eq!(list_months(vault).unwrap(), ["2026-03", "2026-02"]);
        // A retention of zero still keeps the current month.
        record_with_retention(vault, &entry_in("2026-04", "a", "april"), 0).unwrap();
        assert_eq!(list_months(vault).unwrap(), ["2026-04"]);
    }

    #[test]
    fn a_corrupt_line_is_skipped_not_fatal() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        record(vault, &entry("a", "first", 200)).unwrap();
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(month_file(vault, &month_of(&Utc::now())))
            .unwrap();
        f.write_all(b"{ truncated by a crash").unwrap();
        record(vault, &entry("a", "second", 200)).unwrap();
        let recent = read_recent(vault, 10, None).unwrap();
        // The corrupt fragment joined the following line, so that one is lost
        // too; everything else is intact.
        assert!(recent.iter().any(|e| e.action == "first"));
    }

    #[test]
    fn the_log_is_owner_only_and_never_holds_a_query_string() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        record(vault, &entry("a", "search", 200)).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(month_file(vault, &month_of(&Utc::now())))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
            let dir_mode = std::fs::metadata(log_dir(vault))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(dir_mode, 0o700);
        }
        // The entry type has no field for a query; the middleware strips it
        // before building one. This pins the shape.
        let json = serde_json::to_string(&entry("a", "search", 200)).unwrap();
        assert!(!json.contains("query"));
    }

    #[test]
    fn an_unauthenticated_attempt_is_recorded_without_a_client() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        let e = AccessEntry {
            client_id: String::new(),
            client_name: "(unauthenticated)".to_string(),
            scope: None,
            status: 401,
            ..entry("", "auth.rejected", 401)
        };
        record(vault, &e).unwrap();
        let back = read_recent(vault, 1, None).unwrap();
        assert_eq!(back[0].status, 401);
        assert!(back[0].scope.is_none());
    }
}
