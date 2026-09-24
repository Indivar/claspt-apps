// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Page management: CRUD for the `.md` note files that make up a vault.
//!
//! Every note is a portable Markdown file with a YAML frontmatter header. This
//! module owns everything that reads or writes those files, split into focused
//! submodules:
//!
//! - [`model`] — the [`model::Page`] / [`model::PageMeta`] types plus frontmatter
//!   parse/serialize and filename/snippet helpers.
//! - [`crud`] — create/read/update/delete of pages and folders, with path-traversal
//!   guards and atomic writes.
//! - [`secret`] — the `:::secret[Label]…:::` fence format: encrypt-on-save,
//!   decrypt-on-read, and block-level (field) operations.
//! - [`media`] — image/attachment storage under each folder's `_media/` directory.
//! - [`agent_memory`] / [`agent_secret`] — agent-facing (MCP) memory notes and
//!   credential storage, layered on top of the CRUD and secret primitives.
//! - [`error`] — the shared [`error::PageError`] type surfaced to the frontend.
//!
//! Tauri command handlers (defined elsewhere in the backend) call into these
//! functions; the functions themselves are transport-agnostic and operate on a
//! vault directory path.
pub mod agent_memory;
pub mod agent_secret;
pub mod credential_shape;
pub mod crud;
pub mod error;
pub mod media;
pub mod model;
pub mod passkeys;
pub mod secret;
pub mod secret_guard;
pub mod trash;

/// A vault-relative path as the vault stores it: components joined by `/`
/// whatever the operating system's separator.
///
/// Page paths and folder names live in frontmatter, in links, in the search
/// index and in sync bundles, and a vault moves between machines. Rendering
/// a `Path` with `to_string_lossy` gave `logins\work` on Windows, which no
/// `/` path ever matched: attachment references were not found, a capture
/// was stored twice, and a synced vault disagreed with itself across
/// machines. Root and prefix components never belong in a relative path and
/// are dropped.
pub fn slash_path(path: &std::path::Path) -> String {
    let mut out = String::new();
    for component in path.components() {
        if let std::path::Component::Normal(part) = component {
            if !out.is_empty() {
                out.push('/');
            }
            out.push_str(&part.to_string_lossy());
        }
    }
    out
}

#[cfg(test)]
mod path_tests {
    use super::slash_path;
    use std::path::Path;

    /// Built with `join`, so on Windows the input carries backslashes and on
    /// Unix slashes; the answer must be the same everywhere.
    #[test]
    fn a_relative_path_is_rendered_with_slashes_on_every_platform() {
        let path = Path::new("logins").join("work").join("bank.md");
        assert_eq!(slash_path(&path), "logins/work/bank.md");
        assert_eq!(slash_path(Path::new("general")), "general");
        assert_eq!(slash_path(Path::new("")), "");
    }

    #[test]
    fn root_and_current_dir_components_are_dropped() {
        let stripped = Path::new("/vault/a/b.md").strip_prefix("/vault").unwrap();
        assert_eq!(slash_path(stripped), "a/b.md");
        assert_eq!(slash_path(Path::new("./a/./b.md")), "a/b.md");
    }
}
