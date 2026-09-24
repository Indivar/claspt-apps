// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Which vault was open last, remembered across launches.
//!
//! The local API auto-starts at launch by reading a vault's `config.json`.
//! It used to read the *default* vault directory, because that is the only
//! path available before anything is unlocked. Anyone keeping their vault
//! somewhere else therefore got the default vault's answer to "is the local
//! API enabled", which for a fresh default directory is "no". The result was
//! an app whose Integrations tab showed the setting switched on while nothing
//! was listening, and no way to tell from the window why.
//!
//! The path is not a secret: it is a directory name the person chose, and it
//! is already visible in the window title and the recent-files list. Nothing
//! else is stored here.

use std::path::{Path, PathBuf};

const FILE: &str = "last-vault.txt";

/// The bundle identifier, which names the app's configuration directory on
/// every platform (`~/Library/Application Support/<id>`, `%APPDATA%\<id>`,
/// `~/.config/<id>`). The CLI has no app handle, so it builds the same path
/// from this and `dirs::config_dir()`.
pub const APP_IDENTIFIER: &str = "in.indivar.claspt";

/// The app's configuration directory as the CLI sees it: the directory Tauri
/// resolves as `app_config_dir` for this identifier.
pub fn app_config_dir() -> Option<PathBuf> {
    dirs::config_dir().map(|dir| dir.join(APP_IDENTIFIER))
}

/// The vault a command-line invocation works on.
///
/// `CLASPT_VAULT_DIR` wins when set. Otherwise the vault the app opened last,
/// because that is the vault whose client registry the running app consults:
/// a token registered anywhere else is refused with "Invalid token", which is
/// exactly what `claspt mcp install` produced for anyone whose vault is not in
/// the default directory. The default directory is the last resort, for a
/// machine where the app has never run.
pub fn cli_vault_dir(
    env_override: Option<&str>,
    app_config_dir: Option<&Path>,
    home: &Path,
) -> PathBuf {
    if let Some(dir) = env_override.map(str::trim).filter(|d| !d.is_empty()) {
        return PathBuf::from(dir);
    }
    if let Some(dir) = app_config_dir.and_then(recall) {
        return dir;
    }
    home.join("Claspt")
}

fn record_path(app_config_dir: &Path) -> PathBuf {
    app_config_dir.join(FILE)
}

/// Remember this vault as the one to consult at the next launch.
///
/// Failure is deliberately silent: not remembering costs one fall back to the
/// default directory next time, which is exactly the old behaviour, and is
/// never worth failing an unlock over.
pub fn remember(app_config_dir: &Path, vault_dir: &Path) {
    if std::fs::create_dir_all(app_config_dir).is_err() {
        return;
    }
    let _ = std::fs::write(
        record_path(app_config_dir),
        vault_dir.to_string_lossy().as_bytes(),
    );
}

/// The vault to consult at launch: the last one opened, when it is still
/// there, otherwise `None` so the caller falls back to the default.
///
/// An absent or unreadable record is not an error. A recorded directory that
/// no longer holds a vault is ignored rather than trusted, because a vault on
/// a drive that is not mounted would otherwise have the app start a listener
/// for settings it cannot read.
pub fn recall(app_config_dir: &Path) -> Option<PathBuf> {
    let text = std::fs::read_to_string(record_path(app_config_dir)).ok()?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    let dir = PathBuf::from(trimmed);
    if dir.join(".securenotes").join("config.json").is_file() {
        Some(dir)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault_at(root: &Path) -> PathBuf {
        let dir = root.join("MyVault");
        std::fs::create_dir_all(dir.join(".securenotes")).unwrap();
        std::fs::write(dir.join(".securenotes").join("config.json"), "{}").unwrap();
        dir
    }

    #[test]
    fn the_cli_follows_the_app_to_the_vault_it_opened_last() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let config_dir = tmp.path().join("config");
        let vault = vault_at(tmp.path());

        // Nothing remembered yet: the default directory.
        assert_eq!(
            cli_vault_dir(None, Some(&config_dir), &home),
            home.join("Claspt")
        );

        // The app opened a vault elsewhere: the CLI goes there too.
        remember(&config_dir, &vault);
        assert_eq!(cli_vault_dir(None, Some(&config_dir), &home), vault);

        // A remembered vault that is gone is not trusted.
        std::fs::remove_dir_all(&vault).unwrap();
        assert_eq!(
            cli_vault_dir(None, Some(&config_dir), &home),
            home.join("Claspt")
        );

        // The environment wins over everything, and blank means unset.
        assert_eq!(
            cli_vault_dir(Some("/elsewhere"), Some(&config_dir), &home),
            PathBuf::from("/elsewhere")
        );
        assert_eq!(cli_vault_dir(Some("  "), None, &home), home.join("Claspt"));
    }

    #[test]
    fn remembers_and_recalls_a_vault() {
        let tmp = tempfile::tempdir().unwrap();
        let config_dir = tmp.path().join("config");
        let vault = vault_at(tmp.path());

        remember(&config_dir, &vault);
        assert_eq!(recall(&config_dir), Some(vault));
    }

    #[test]
    fn nothing_recorded_means_no_answer() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(recall(&tmp.path().join("config")), None);
    }

    #[test]
    fn a_vault_that_is_no_longer_there_is_not_trusted() {
        // An external drive that is not mounted, or a folder since deleted.
        let tmp = tempfile::tempdir().unwrap();
        let config_dir = tmp.path().join("config");
        let vault = vault_at(tmp.path());
        remember(&config_dir, &vault);
        std::fs::remove_dir_all(&vault).unwrap();

        assert_eq!(recall(&config_dir), None);
    }

    #[test]
    fn a_blank_record_is_no_answer() {
        let tmp = tempfile::tempdir().unwrap();
        let config_dir = tmp.path().join("config");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::write(record_path(&config_dir), "   \n").unwrap();

        assert_eq!(recall(&config_dir), None);
    }

    #[test]
    fn the_newest_vault_wins() {
        let tmp = tempfile::tempdir().unwrap();
        let config_dir = tmp.path().join("config");
        let first = vault_at(tmp.path());
        let second = tmp.path().join("Second");
        std::fs::create_dir_all(second.join(".securenotes")).unwrap();
        std::fs::write(second.join(".securenotes").join("config.json"), "{}").unwrap();

        remember(&config_dir, &first);
        remember(&config_dir, &second);
        assert_eq!(recall(&config_dir), Some(second));
    }
}
