// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Owner-only permissions for files and directories that hold key material,
//! tokens, or decrypted exports.
//!
//! One function, [`restrict_to_owner`], with an implementation per platform
//! family. It exists because the Unix branch used to be the only one: a
//! `#[cfg(unix)]` chmod with nothing on Windows, so `vault.key`, the vault
//! config with its API tokens, and every file a Windows install wrote were
//! left with the inherited user-profile ACL, which any process running as the
//! user, and administrators, can read. The threat model said "owner-only" and
//! it was true on two of three platforms.
//!
//! **Unix** (macOS, Linux, and the mobile sandboxes): mode `0600` for files,
//! `0700` for directories.
//!
//! **Windows**: a protected DACL containing one access-allowed ACE, full
//! control for the current user's SID, inheritance from the parent disabled.
//! Administrators are not granted access; they can take ownership, which is
//! the Windows equivalent of root reading a `0600` file, and is visible in the
//! file's security tab afterwards. `SYSTEM` is not granted access either: this
//! process runs as the user, and nothing that runs as `SYSTEM` needs to read a
//! vault key. Directories get the ACE with container-and-object inheritance so
//! files created inside them start owner-only too.

use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// Make `path` readable and writable by the current user only.
///
/// Applies to the path as it is now; a later `rename` over it keeps the
/// permissions of the renamed file, which is why writers restrict the
/// temporary file before renaming it into place.
pub fn restrict_to_owner(path: &Path) -> io::Result<()> {
    imp::restrict_to_owner(path)
}

/// Create `path` so that it is owner-only from its first instant.
///
/// A writer that creates a file and restricts it afterwards leaves a window in
/// which the file has the umask's permissions. That window is short but it is
/// not harmless: another local user who opens the file inside it keeps the
/// descriptor, and a descriptor survives the later chmod, so the bytes written
/// afterwards are readable through it. On Unix the mode is therefore part of
/// the `open(2)` call itself. On Windows the file is created empty and its
/// DACL is replaced before any bytes are written; a handle opened in between
/// sees an empty file. Both branches create with `create_new`, so a file
/// (or symlink) planted at the path beforehand fails the call rather than
/// being written through; a leftover temporary from an earlier crash is
/// removed first.
pub fn create_owner_only(path: &Path) -> io::Result<std::fs::File> {
    if let Err(e) = std::fs::remove_file(path) {
        if e.kind() != io::ErrorKind::NotFound {
            return Err(e);
        }
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path)?;
    restrict_to_owner(path)?;
    Ok(file)
}

/// Write `data` to `path` atomically and owner-only.
///
/// The bytes go to a sibling temporary file made by [`create_owner_only`], are
/// flushed to the disk with `sync_all`, and the temporary is renamed over
/// `path`. A crash or power loss at any point leaves either the previous file
/// or the complete new one, never a truncated one, which matters most for
/// `vault.key`: a half-written key file is a vault nobody can open.
pub fn write_owner_only(path: &Path, data: &[u8]) -> io::Result<()> {
    let tmp_path = temp_sibling(path);
    let written = create_owner_only(&tmp_path).and_then(|mut file| {
        file.write_all(data)?;
        file.sync_all()
    });
    let result = written.and_then(|()| std::fs::rename(&tmp_path, path));
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp_path);
    }
    result
}

/// `<name>.tmp` beside `path`. The suffix is appended rather than swapped for
/// the extension so `vault.key` and `vault.json` cannot share a temporary, and
/// so every temporary matches the `*.tmp` rule in the vault's `.gitignore`.
fn temp_sibling(path: &Path) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(".tmp");
    path.with_file_name(name)
}

#[cfg(unix)]
mod imp {
    use std::io;
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;

    pub fn restrict_to_owner(path: &Path) -> io::Result<()> {
        let mode = if std::fs::metadata(path)?.is_dir() {
            0o700
        } else {
            0o600
        };
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
    }
}

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;
    use std::io;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{
        CloseHandle, LocalFree, ERROR_SUCCESS, GENERIC_ALL, HANDLE, HLOCAL,
    };
    use windows::Win32::Security::Authorization::{
        SetEntriesInAclW, SetNamedSecurityInfoW, EXPLICIT_ACCESS_W, SET_ACCESS, SE_FILE_OBJECT,
        TRUSTEE_IS_SID, TRUSTEE_IS_USER, TRUSTEE_W,
    };
    use windows::Win32::Security::{
        GetTokenInformation, TokenUser, ACL, DACL_SECURITY_INFORMATION, NO_INHERITANCE,
        PROTECTED_DACL_SECURITY_INFORMATION, SUB_CONTAINERS_AND_OBJECTS_INHERIT, TOKEN_QUERY,
        TOKEN_USER,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    /// A process token handle that closes itself.
    struct Token(HANDLE);
    impl Drop for Token {
        fn drop(&mut self) {
            // SAFETY: the handle came from OpenProcessToken and is closed once.
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    /// An ACL allocated by SetEntriesInAclW, which must be freed with LocalFree.
    struct LocalAcl(*mut ACL);
    impl Drop for LocalAcl {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY: SetEntriesInAclW documents LocalFree as the release.
                unsafe {
                    let _ = LocalFree(Some(HLOCAL(self.0 as *mut c_void)));
                }
            }
        }
    }

    /// The current process user's SID, as the bytes of a TOKEN_USER buffer.
    /// The SID pointer inside points into this buffer, so the buffer must
    /// outlive every use of it.
    fn current_user_token_info() -> io::Result<Vec<u8>> {
        let mut raw = HANDLE::default();
        // SAFETY: plain Win32 call with a valid out-pointer.
        unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) }
            .map_err(|e| io::Error::other(format!("OpenProcessToken: {e}")))?;
        let token = Token(raw);

        let mut needed = 0u32;
        // First call sizes the buffer; it fails with ERROR_INSUFFICIENT_BUFFER by design.
        // SAFETY: a null buffer with length 0 is the documented sizing call.
        let _ = unsafe { GetTokenInformation(token.0, TokenUser, None, 0, &mut needed) };
        if needed == 0 {
            return Err(io::Error::other("GetTokenInformation reported no size"));
        }
        let mut buffer = vec![0u8; needed as usize];
        // SAFETY: buffer is `needed` bytes and outlives the call.
        unsafe {
            GetTokenInformation(
                token.0,
                TokenUser,
                Some(buffer.as_mut_ptr() as *mut c_void),
                needed,
                &mut needed,
            )
        }
        .map_err(|e| io::Error::other(format!("GetTokenInformation: {e}")))?;
        Ok(buffer)
    }

    pub fn restrict_to_owner(path: &Path) -> io::Result<()> {
        let is_dir = std::fs::metadata(path)?.is_dir();
        let token_info = current_user_token_info()?;
        // SAFETY: the buffer was filled by GetTokenInformation(TokenUser) and is
        // at least size_of::<TOKEN_USER>() bytes; the SID it points to lives
        // inside the same buffer, which stays alive to the end of this function.
        let user_sid = unsafe { (*(token_info.as_ptr() as *const TOKEN_USER)).User.Sid };

        let access = EXPLICIT_ACCESS_W {
            grfAccessPermissions: GENERIC_ALL.0,
            grfAccessMode: SET_ACCESS,
            grfInheritance: if is_dir {
                SUB_CONTAINERS_AND_OBJECTS_INHERIT
            } else {
                NO_INHERITANCE
            },
            Trustee: TRUSTEE_W {
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_USER,
                ptstrName: PWSTR(user_sid.0 as *mut u16),
                ..Default::default()
            },
        };

        let mut acl_ptr: *mut ACL = std::ptr::null_mut();
        // SAFETY: one entry, no existing ACL, valid out-pointer.
        let status = unsafe { SetEntriesInAclW(Some(&[access]), None, &mut acl_ptr) };
        if status != ERROR_SUCCESS {
            return Err(io::Error::other(format!("SetEntriesInAclW: {status:?}")));
        }
        let acl = LocalAcl(acl_ptr);

        let wide: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        // PROTECTED_DACL turns off inheritance from the parent, so the single
        // ACE above is the whole DACL rather than an addition to it.
        // SAFETY: `wide` is NUL-terminated and outlives the call; the ACL is valid.
        let status = unsafe {
            SetNamedSecurityInfoW(
                PCWSTR(wide.as_ptr()),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                None,
                None,
                Some(acl.0 as *const ACL),
                None,
            )
        };
        if status != ERROR_SUCCESS {
            return Err(io::Error::other(format!(
                "SetNamedSecurityInfoW: {status:?}"
            )));
        }
        Ok(())
    }

    /// Test support: the number of ACEs in the file's DACL and whether the
    /// DACL is protected from inheritance. Owner-only means exactly one ACE
    /// and protected.
    #[cfg(test)]
    pub fn dacl_shape(path: &Path) -> io::Result<(u32, bool)> {
        use windows::Win32::Security::Authorization::GetNamedSecurityInfoW;
        use windows::Win32::Security::{
            AclSizeInformation, GetAclInformation, GetSecurityDescriptorControl,
            ACL_SIZE_INFORMATION, PSECURITY_DESCRIPTOR, SECURITY_DESCRIPTOR_CONTROL,
            SE_DACL_PROTECTED,
        };

        let wide: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let mut dacl: *mut ACL = std::ptr::null_mut();
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        // SAFETY: valid out-pointers; the descriptor is freed below.
        let status = unsafe {
            GetNamedSecurityInfoW(
                PCWSTR(wide.as_ptr()),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                None,
                None,
                Some(&mut dacl),
                None,
                &mut descriptor,
            )
        };
        if status != ERROR_SUCCESS {
            return Err(io::Error::other(format!(
                "GetNamedSecurityInfoW: {status:?}"
            )));
        }
        let mut size_info = ACL_SIZE_INFORMATION::default();
        // The control word is a plain u16 at the FFI boundary.
        let mut control = 0u16;
        let mut revision = 0u32;
        // SAFETY: dacl and descriptor were returned by the call above.
        let result = unsafe {
            GetAclInformation(
                dacl,
                &mut size_info as *mut _ as *mut c_void,
                std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
                AclSizeInformation,
            )
            .and_then(|_| GetSecurityDescriptorControl(descriptor, &mut control, &mut revision))
        };
        // SAFETY: GetNamedSecurityInfoW documents LocalFree for the descriptor.
        unsafe {
            let _ = LocalFree(Some(HLOCAL(descriptor.0)));
        }
        result.map_err(|e| io::Error::other(format!("reading DACL: {e}")))?;
        let protected =
            SECURITY_DESCRIPTOR_CONTROL(control & SE_DACL_PROTECTED.0) == SE_DACL_PROTECTED;
        Ok((size_info.AceCount, protected))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn files_become_0600_and_directories_0700() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("k");
        let sub = dir.path().join("d");
        std::fs::write(&file, b"x").unwrap();
        std::fs::create_dir(&sub).unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
        std::fs::set_permissions(&sub, std::fs::Permissions::from_mode(0o755)).unwrap();

        restrict_to_owner(&file).unwrap();
        restrict_to_owner(&sub).unwrap();

        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&file), 0o600);
        assert_eq!(mode(&sub), 0o700);
    }

    #[cfg(windows)]
    #[test]
    fn files_and_directories_get_a_single_protected_ace() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("k");
        let sub = dir.path().join("d");
        std::fs::write(&file, b"x").unwrap();
        std::fs::create_dir(&sub).unwrap();

        // A fresh file in a temp dir inherits several ACEs and is not protected.
        let (before, protected_before) = imp::dacl_shape(&file).unwrap();
        assert!(
            before > 1 || !protected_before,
            "fixture already owner-only"
        );

        restrict_to_owner(&file).unwrap();
        restrict_to_owner(&sub).unwrap();

        assert_eq!(imp::dacl_shape(&file).unwrap(), (1, true));
        assert_eq!(imp::dacl_shape(&sub).unwrap(), (1, true));

        // Still usable by the owner afterwards.
        std::fs::write(&file, b"y").unwrap();
        std::fs::write(sub.join("child"), b"z").unwrap();
        // And a file created inside the directory inherits owner-only.
        assert_eq!(imp::dacl_shape(&sub.join("child")).unwrap().0, 1);
    }

    #[cfg(unix)]
    #[test]
    fn files_are_owner_only_from_creation_and_writes_are_atomic() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("vault.key");

        write_owner_only(&target, b"first").unwrap();
        let mode = std::fs::metadata(&target).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        assert_eq!(std::fs::read(&target).unwrap(), b"first");
        assert!(
            !dir.path().join("vault.key.tmp").exists(),
            "temporary left behind"
        );

        // A rewrite replaces the content in one step and stays owner-only.
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o644)).unwrap();
        write_owner_only(&target, b"second").unwrap();
        let mode = std::fs::metadata(&target).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        assert_eq!(std::fs::read(&target).unwrap(), b"second");
    }

    #[test]
    fn a_planted_symlink_at_the_temporary_is_not_written_through() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("vault.key");
        let elsewhere = dir.path().join("elsewhere");
        std::fs::write(&elsewhere, b"untouched").unwrap();
        // A stale temporary is removed and recreated, so a symlink left there
        // is replaced by a real file rather than followed.
        #[cfg(unix)]
        std::os::unix::fs::symlink(&elsewhere, dir.path().join("vault.key.tmp")).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(&elsewhere, dir.path().join("vault.key.tmp")).unwrap();

        write_owner_only(&target, b"secret").unwrap();
        assert_eq!(std::fs::read(&elsewhere).unwrap(), b"untouched");
        assert_eq!(std::fs::read(&target).unwrap(), b"secret");
    }

    #[test]
    fn temporaries_keep_the_whole_file_name() {
        assert_eq!(
            temp_sibling(Path::new("/v/.securenotes/vault.key")),
            PathBuf::from("/v/.securenotes/vault.key.tmp")
        );
        assert_eq!(
            temp_sibling(Path::new("/v/.securenotes/config.json")),
            PathBuf::from("/v/.securenotes/config.json.tmp")
        );
    }

    #[test]
    fn a_missing_path_is_an_error_not_a_silent_pass() {
        let dir = tempfile::tempdir().unwrap();
        assert!(restrict_to_owner(&dir.path().join("absent")).is_err());
    }
}
