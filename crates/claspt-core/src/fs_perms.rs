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

use std::io;
use std::path::Path;

/// Make `path` readable and writable by the current user only.
///
/// Applies to the path as it is now; a later `rename` over it keeps the
/// permissions of the renamed file, which is why writers restrict the
/// temporary file before renaming it into place.
pub fn restrict_to_owner(path: &Path) -> io::Result<()> {
    imp::restrict_to_owner(path)
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

    #[test]
    fn a_missing_path_is_an_error_not_a_silent_pass() {
        let dir = tempfile::tempdir().unwrap();
        assert!(restrict_to_owner(&dir.path().join("absent")).is_err());
    }
}
