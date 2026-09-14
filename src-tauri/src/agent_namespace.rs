// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Which memory namespace an agent session belongs to, and how that is decided.
//!
//! Memory lives under `ai/memory/<namespace>/`, so the namespace is the whole
//! of a project's identity as far as an agent is concerned. Getting it wrong is
//! silent: two projects that resolve to the same name share one memory, and a
//! project that resolves differently on Tuesday than it did on Monday has lost
//! its memory without an error anywhere.
//!
//! Resolution order, first hit wins:
//!
//! 1. `CLASPT_AGENT_NS` in the environment. An explicit override for hosts that
//!    set it per server entry.
//! 2. A `.claspt` marker file, searched from the working directory upward. The
//!    file is committed with the project, so every clone on every machine
//!    resolves the same name, a renamed folder keeps its memory, and a session
//!    started inside a monorepo package still lands on the repo's namespace.
//! 3. The sanitized name of the working directory. This is what every vault
//!    created before the marker existed is using, so it stays the default
//!    rather than being replaced by something cleverer: changing it would move
//!    every existing project to a new, empty namespace.
//! 4. `default`, when the working directory carries no project identity (the
//!    filesystem root, or the home directory).
//!
//! The `.claspt` file holds `key = value` lines; `#` starts a comment. Only
//! `namespace` is read today. Later settings for the same project go in the
//! same file, which is why it is not a bare one-word file.

use std::path::{Path, PathBuf};

use crate::pages::agent_memory::{sanitize_namespace, validate_agent_namespace, GLOBAL_NAMESPACE};

/// Name of the per-project marker file.
pub const MARKER_FILE: &str = ".claspt";

const ENV_OVERRIDE: &str = "CLASPT_AGENT_NS";

/// Where a resolved namespace came from. Reported back to agents so a session
/// can tell a pinned namespace from a guessed one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum NamespaceSource {
    Environment,
    Marker,
    FolderName,
    Default,
}

/// A resolved namespace and its provenance.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ResolvedNamespace {
    pub namespace: String,
    pub source: NamespaceSource,
    /// The marker file that decided it, when `source` is `Marker`.
    pub marker_path: Option<PathBuf>,
}

/// Resolve for the current process: environment, then the working directory.
pub fn resolve() -> ResolvedNamespace {
    if let Ok(ns) = std::env::var(ENV_OVERRIDE) {
        let ns = ns.trim();
        if !ns.is_empty() {
            return ResolvedNamespace {
                namespace: ns.to_string(),
                source: NamespaceSource::Environment,
                marker_path: None,
            };
        }
    }
    let cwd = std::env::current_dir().ok();
    let home = dirs::home_dir();
    resolve_from(cwd.as_deref(), home.as_deref())
}

/// The part of [`resolve`] that does not touch process state, so it can be
/// tested against temporary directories without changing the test runner's
/// working directory.
pub fn resolve_from(start: Option<&Path>, home: Option<&Path>) -> ResolvedNamespace {
    let Some(start) = start else {
        return default();
    };
    if let Some((namespace, marker_path)) = marker_namespace(start, home) {
        return ResolvedNamespace {
            namespace,
            source: NamespaceSource::Marker,
            marker_path: Some(marker_path),
        };
    }
    match namespace_from_folder(start, home) {
        Some(namespace) => ResolvedNamespace {
            namespace,
            source: NamespaceSource::FolderName,
            marker_path: None,
        },
        None => default(),
    }
}

fn default() -> ResolvedNamespace {
    ResolvedNamespace {
        namespace: "default".to_string(),
        source: NamespaceSource::Default,
        marker_path: None,
    }
}

/// Walk from `start` upward looking for a marker with a usable `namespace`.
///
/// The walk stops before the home directory and at the filesystem root, so a
/// marker placed in `$HOME` cannot quietly give every project the same memory.
/// A marker that is present but unusable (missing key, invalid name, or the
/// reserved `global`) is reported on stderr and skipped rather than treated as
/// absent silently; the walk then continues upward.
fn marker_namespace(start: &Path, home: Option<&Path>) -> Option<(String, PathBuf)> {
    let mut dir = Some(start);
    while let Some(current) = dir {
        if home.is_some_and(|h| h == current) {
            return None;
        }
        let candidate = current.join(MARKER_FILE);
        if candidate.is_file() {
            match std::fs::read_to_string(&candidate) {
                Ok(text) => match namespace_from_marker_text(&text) {
                    Ok(ns) => return Some((ns, candidate)),
                    Err(reason) => {
                        eprintln!("[claspt] ignoring {}: {reason}", candidate.display());
                    }
                },
                Err(e) => eprintln!("[claspt] cannot read {}: {e}", candidate.display()),
            }
        }
        dir = current.parent();
    }
    None
}

/// Parse the marker's `namespace` value and check it is a name the memory
/// layer will accept.
pub fn namespace_from_marker_text(text: &str) -> Result<String, String> {
    let value = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .find_map(|line| {
            let (key, value) = line.split_once('=')?;
            (key.trim() == "namespace").then(|| value.trim().trim_matches(['"', '\'']).to_string())
        })
        .ok_or_else(|| "no `namespace = ...` line".to_string())?;
    validate_agent_namespace(&value).map_err(|e| e.to_string())?;
    if value == GLOBAL_NAMESPACE {
        return Err(format!(
            "`{GLOBAL_NAMESPACE}` is reserved for the shared namespace"
        ));
    }
    Ok(value)
}

/// The text to write when pinning `namespace`.
pub fn marker_text(namespace: &str) -> String {
    format!(
        "# Claspt project settings. Committed with the project so every clone\n\
         # resolves the same agent memory namespace (ai/memory/{namespace}/).\n\
         namespace = \"{namespace}\"\n"
    )
}

/// Derive a namespace from a directory's own name, or `None` when the
/// directory carries no project identity (filesystem root, home directory).
fn namespace_from_folder(dir: &Path, home: Option<&Path>) -> Option<String> {
    dir.parent()?; // the filesystem root has no parent and no identity
    if home.is_some_and(|h| h == dir) {
        return None;
    }
    let name = dir.file_name()?.to_string_lossy().to_string();
    let ns = sanitize_namespace(&name)?;
    // "global" is reserved for the shared cross-project namespace; a project
    // folder that happens to be named "global" must not merge into it.
    if ns == GLOBAL_NAMESPACE {
        return Some(format!("{ns}-project"));
    }
    Some(ns)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_marker(dir: &Path, text: &str) {
        std::fs::write(dir.join(MARKER_FILE), text).unwrap();
    }

    #[test]
    fn folder_name_is_the_default_when_no_marker_exists() {
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("My Project");
        std::fs::create_dir_all(&project).unwrap();
        let r = resolve_from(Some(&project), None);
        assert_eq!(r.namespace, "my-project");
        assert_eq!(r.source, NamespaceSource::FolderName);
    }

    #[test]
    fn marker_wins_over_folder_name_and_is_found_from_a_subdirectory() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("checkout-2");
        let deep = repo.join("packages").join("api");
        std::fs::create_dir_all(&deep).unwrap();
        write_marker(&repo, "# pinned\nnamespace = \"acme-billing\"\n");

        let r = resolve_from(Some(&deep), None);
        assert_eq!(r.namespace, "acme-billing");
        assert_eq!(r.source, NamespaceSource::Marker);
        assert_eq!(
            r.marker_path.as_deref(),
            Some(repo.join(MARKER_FILE).as_path())
        );
    }

    #[test]
    fn the_walk_stops_before_the_home_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let project = home.join("work").join("thing");
        std::fs::create_dir_all(&project).unwrap();
        // A marker in $HOME must not apply to every project under it.
        write_marker(&home, "namespace = \"everything\"\n");

        let r = resolve_from(Some(&project), Some(&home));
        assert_eq!(r.namespace, "thing");
        assert_eq!(r.source, NamespaceSource::FolderName);
        // And the home directory itself has no project identity.
        assert_eq!(
            resolve_from(Some(&home), Some(&home)).source,
            NamespaceSource::Default
        );
    }

    #[test]
    fn an_unusable_marker_is_skipped_not_trusted() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        for bad in [
            "",
            "# nothing here\n",
            "namespace = \"\"\n",
            "namespace = \"has spaces\"\n",
            "namespace = \"global\"\n",
            "namespace = \"../escape\"\n",
        ] {
            write_marker(&repo, bad);
            let r = resolve_from(Some(&repo), None);
            assert_eq!(
                r.source,
                NamespaceSource::FolderName,
                "marker {bad:?} must be ignored"
            );
            assert_eq!(r.namespace, "repo");
        }
    }

    #[test]
    fn marker_text_round_trips_and_tolerates_quotes_and_comments() {
        let text = marker_text("acme-billing");
        assert_eq!(namespace_from_marker_text(&text).unwrap(), "acme-billing");
        assert_eq!(
            namespace_from_marker_text("namespace=plain").unwrap(),
            "plain"
        );
        assert_eq!(
            namespace_from_marker_text("namespace = 'single'").unwrap(),
            "single"
        );
        assert_eq!(
            namespace_from_marker_text("other = 1\n# namespace = commented\nnamespace = real")
                .unwrap(),
            "real"
        );
    }

    #[test]
    fn a_folder_named_global_does_not_merge_into_the_shared_namespace() {
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("global");
        std::fs::create_dir_all(&project).unwrap();
        assert_eq!(
            resolve_from(Some(&project), None).namespace,
            "global-project"
        );
    }

    #[test]
    fn no_working_directory_means_default() {
        assert_eq!(resolve_from(None, None).source, NamespaceSource::Default);
    }
}
