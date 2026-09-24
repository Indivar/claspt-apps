// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! The recovery key, written out as a file a person can still understand in a
//! year's time.
//!
//! The setup wizard used to offer only "Copy", which puts a 44-character base64
//! string on the clipboard and nowhere else. A clipboard survives until the
//! next copy. This module builds a self-describing sheet instead: which vault
//! it belongs to, when it was made, and what to do with it, around the key
//! itself. Someone who finds the file long after forgetting it exists can act
//! on it without guessing.
//!
//! The file is written owner-only via [`crate::vault::init::write_restricted`],
//! which is a real restriction on Windows as well as Unix — see
//! [`claspt_core::fs_perms`].

use std::path::{Component, Path};

use zeroize::Zeroizing;

/// Why a recovery key could not be written.
#[derive(Debug, thiserror::Error)]
pub enum RecoverySheetError {
    /// The chosen location is inside the vault it unlocks.
    #[error("a recovery key must not be saved inside the vault it unlocks: anything in the vault folder is committed to its version history and copied to every synced device, so the key would travel with the data it protects")]
    InsideVault,
    #[error("could not write the recovery key: {0}")]
    Write(String),
}

/// Whether `target` lies inside `vault_dir`.
///
/// Compared after normalising both paths rather than by string prefix, so
/// `~/Claspt/../Documents/key.txt` is correctly seen as outside and
/// `~/Claspt/general/key.txt` as inside. Neither path is required to exist:
/// the file is being created, and the check has to happen before it does.
pub fn is_inside_vault(target: &Path, vault_dir: &Path) -> bool {
    let target = normalise(target);
    let vault = normalise(vault_dir);
    target.starts_with(&vault)
}

/// Resolve `.` and `..` lexically. Not `canonicalize`, which requires the path
/// to exist and would refuse the file we are about to create.
fn normalise(path: &Path) -> std::path::PathBuf {
    let mut out = std::path::PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Build the text of the recovery sheet.
///
/// `saved_on` is passed in rather than read from the clock so the output is
/// testable.
pub fn build(
    recovery_key: &str,
    vault_dir: &Path,
    app_version: &str,
    saved_on: &str,
) -> Zeroizing<String> {
    Zeroizing::new(format!(
        "CLASPT RECOVERY KEY\n\
         ===================\n\
         \n\
         This is the recovery key for the Claspt vault below. If the master\n\
         password for that vault is forgotten, this key is the only way back\n\
         into it. Nobody at Claspt can reset the password or open the vault,\n\
         and there is no other copy of this key anywhere.\n\
         \n\
         Anyone holding both this file and the vault folder can read\n\
         everything in the vault. Keep it somewhere only you can reach, and\n\
         not in the vault folder itself.\n\
         \n\
         Vault:    {vault}\n\
         Saved:    {saved_on}\n\
         App:      Claspt {app_version}\n\
         \n\
         RECOVERY KEY\n\
         \n\
         \x20   {recovery_key}\n\
         \n\
         HOW TO USE IT\n\
         \n\
         \x20 1. Open Claspt and choose the vault folder shown above.\n\
         \x20 2. Click \"Forgot password?\" on the unlock screen.\n\
         \x20 3. Paste the key above, then set a new master password.\n\
         \n\
         The key does not change when the password does, so this file stays\n\
         valid after a password reset.\n",
        vault = vault_dir.display(),
    ))
}

/// Write the sheet to `target`, owner-only, refusing a location inside the vault.
pub fn write(
    recovery_key: &str,
    target: &Path,
    vault_dir: &Path,
    app_version: &str,
    saved_on: &str,
) -> Result<(), RecoverySheetError> {
    if is_inside_vault(target, vault_dir) {
        return Err(RecoverySheetError::InsideVault);
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| RecoverySheetError::Write(e.to_string()))?;
    }
    let sheet = build(recovery_key, vault_dir, app_version, saved_on);
    crate::vault::init::write_restricted(target, sheet.as_bytes())
        .map_err(|e| RecoverySheetError::Write(e.to_string()))
}

/// The filename offered in the save dialog: recognisable a year later, and
/// distinct per vault so two vaults' keys do not overwrite each other.
pub fn suggested_filename(vault_dir: &Path, saved_on: &str) -> String {
    let vault_name = vault_dir
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "Vault".to_string());
    format!("Claspt Recovery Key - {vault_name} - {saved_on}.txt")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn a_location_inside_the_vault_is_refused() {
        // The vault folder is committed to git on every change and copied to
        // every synced device, so a key saved there travels with the data it
        // unlocks.
        let vault = PathBuf::from("/home/me/Claspt");
        assert!(is_inside_vault(
            &PathBuf::from("/home/me/Claspt/general/key.txt"),
            &vault
        ));
        assert!(is_inside_vault(
            &PathBuf::from("/home/me/Claspt/key.txt"),
            &vault
        ));
    }

    #[test]
    fn a_location_outside_the_vault_is_allowed() {
        let vault = PathBuf::from("/home/me/Claspt");
        assert!(!is_inside_vault(
            &PathBuf::from("/home/me/Documents/key.txt"),
            &vault
        ));
        // A sibling whose name merely starts with the vault's name is outside
        // it. A string prefix test would get this wrong.
        assert!(!is_inside_vault(
            &PathBuf::from("/home/me/Claspt-backup/key.txt"),
            &vault
        ));
    }

    #[test]
    fn dot_dot_cannot_smuggle_the_file_into_the_vault() {
        let vault = PathBuf::from("/home/me/Claspt");
        assert!(is_inside_vault(
            &PathBuf::from("/home/me/Documents/../Claspt/key.txt"),
            &vault
        ));
    }

    #[test]
    fn writing_inside_the_vault_fails_and_creates_nothing() {
        let tmp = tempfile::TempDir::new().unwrap();
        let vault = tmp.path().join("Claspt");
        std::fs::create_dir_all(&vault).unwrap();
        let target = vault.join("key.txt");

        let err = write("KEY", &target, &vault, "3.3.34", "17 September 2026")
            .expect_err("saving into the vault must be refused");
        assert!(matches!(err, RecoverySheetError::InsideVault));
        assert!(
            !target.exists(),
            "the refused file must not have been written"
        );
    }

    #[test]
    fn the_sheet_says_which_vault_and_how_to_use_it() {
        // A file found a year later has to answer these without the app.
        let sheet = build(
            "RN01RL4AKWKsjhu79X3ETKAKoA8pVom0VeqIqq0p16g=",
            &PathBuf::from("/home/me/Claspt"),
            "3.3.34",
            "17 September 2026",
        );
        assert!(sheet.contains("RN01RL4AKWKsjhu79X3ETKAKoA8pVom0VeqIqq0p16g="));
        assert!(sheet.contains("/home/me/Claspt"));
        assert!(sheet.contains("17 September 2026"));
        assert!(sheet.contains("Forgot password?"));
    }

    #[test]
    fn the_written_file_is_owner_only() {
        let tmp = tempfile::TempDir::new().unwrap();
        let vault = tmp.path().join("Claspt");
        std::fs::create_dir_all(&vault).unwrap();
        let target = tmp.path().join("Documents").join("key.txt");

        write("KEY", &target, &vault, "3.3.34", "17 September 2026").unwrap();
        assert!(target.exists());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&target).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "the recovery key is readable by others");
        }
    }

    #[test]
    fn the_filename_names_the_vault_and_the_date() {
        assert_eq!(
            suggested_filename(&PathBuf::from("/home/me/Claspt"), "17 September 2026"),
            "Claspt Recovery Key - Claspt - 17 September 2026.txt"
        );
    }
}
