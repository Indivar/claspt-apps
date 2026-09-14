// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Platform-specific biometric prompt and availability checks.
//!
//! Presents the native biometric dialog and reports whether biometrics are
//! usable, with one `cfg`-gated implementation per OS: macOS uses Touch ID via
//! `LocalAuthentication`, Windows uses Windows Hello via `UserConsentVerifier`,
//! and Linux plus any other platform report unavailable and return
//! [`BiometricError::NotAvailable`]. Both entry points ([`is_available`] and
//! [`authenticate`]) share the same signature across platforms so callers need
//! no `cfg` of their own.

use super::error::BiometricError;

// ─── macOS: Touch ID via LocalAuthentication ─────────────────────────

/// Return whether biometric authentication can currently be evaluated on this
/// device (hardware present and a biometric enrolled).
#[cfg(target_os = "macos")]
pub fn is_available() -> bool {
    use objc2_local_authentication::{LAContext, LAPolicy};

    let context = unsafe { LAContext::new() };
    unsafe {
        context
            .canEvaluatePolicy_error(LAPolicy::DeviceOwnerAuthenticationWithBiometrics)
            .is_ok()
    }
}

/// Present the biometric prompt with `reason` and block until the user
/// responds. Returns `Ok(())` on a successful check, or
/// [`BiometricError::AuthFailed`] if it fails, is cancelled, or is denied.
/// The async OS callback result is bridged back to this synchronous call
/// over an `mpsc` channel.
#[cfg(target_os = "macos")]
pub fn authenticate(reason: &str) -> Result<(), BiometricError> {
    use block2::RcBlock;
    use objc2_foundation::{NSError, NSString};
    use objc2_local_authentication::{LAContext, LAPolicy};
    use std::sync::mpsc;

    let context = unsafe { LAContext::new() };
    let reason = NSString::from_str(reason);
    let (tx, rx) = mpsc::channel();

    let block = RcBlock::new(move |success: objc2::runtime::Bool, error: *mut NSError| {
        if success.as_bool() {
            let _ = tx.send(Ok(()));
        } else {
            let msg = if error.is_null() {
                "unknown error".to_string()
            } else {
                unsafe { (*error).localizedDescription().to_string() }
            };
            let _ = tx.send(Err(BiometricError::AuthFailed(msg)));
        }
    });

    unsafe {
        context.evaluatePolicy_localizedReason_reply(
            LAPolicy::DeviceOwnerAuthenticationWithBiometrics,
            &reason,
            &block,
        );
    }

    rx.recv()
        .map_err(|_| BiometricError::AuthFailed("callback channel closed".into()))?
}

// ─── Windows: Windows Hello via UserConsentVerifier ──────────────────

#[cfg(target_os = "windows")]
pub fn is_available() -> bool {
    use windows::Security::Credentials::UI::{
        UserConsentVerifier, UserConsentVerifierAvailability,
    };

    UserConsentVerifier::CheckAvailabilityAsync()
        .and_then(|op| op.get())
        .map(|availability| availability == UserConsentVerifierAvailability::Available)
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
pub fn authenticate(reason: &str) -> Result<(), BiometricError> {
    use windows::core::HSTRING;
    use windows::Security::Credentials::UI::{UserConsentVerificationResult, UserConsentVerifier};

    let message = HSTRING::from(reason);
    let result = UserConsentVerifier::RequestVerificationAsync(&message)
        .and_then(|op| op.get())
        .map_err(|e| BiometricError::AuthFailed(e.message().to_string()))?;

    match result {
        UserConsentVerificationResult::Verified => Ok(()),
        _ => Err(BiometricError::AuthFailed("verification denied".into())),
    }
}

// ─── Linux: no standard biometric API ────────────────────────────────

#[cfg(target_os = "linux")]
pub fn is_available() -> bool {
    false
}

#[cfg(target_os = "linux")]
pub fn authenticate(_reason: &str) -> Result<(), BiometricError> {
    Err(BiometricError::NotAvailable)
}

// ─── Fallback for other platforms ────────────────────────────────────

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
pub fn is_available() -> bool {
    false
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
pub fn authenticate(_reason: &str) -> Result<(), BiometricError> {
    Err(BiometricError::NotAvailable)
}
