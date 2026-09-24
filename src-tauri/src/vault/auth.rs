// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Master-password authentication and brute-force throttling.
//!
//! This module enforces the master-password policy ([`validate_password`]) and rate-limits
//! repeated unlock failures via [`BruteForceGuard`]. The guard tracks consecutive failed
//! attempts and, once past a threshold, imposes an exponentially increasing delay. Its counter
//! is persisted to `.securenotes/brute_force.json` so throttling survives app restarts and
//! cannot be reset by simply relaunching. The same guard is shared by password and biometric
//! unlock paths. Key derivation itself (Argon2id) lives in the `crypto` module; this module
//! only gates *when* a derivation attempt is allowed to proceed.

use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::error::VaultError;

/// Minimum master-password length in Unicode scalar values (characters, not bytes).
const MIN_PASSWORD_LENGTH: usize = 12;
/// Number of consecutive failed unlocks tolerated before progressive delays kick in.
const MAX_ATTEMPTS_BEFORE_DELAY: u32 = 5;

/// Validates password meets minimum requirements.
pub fn validate_password(password: &str) -> Result<(), VaultError> {
    if password.chars().count() < MIN_PASSWORD_LENGTH {
        return Err(VaultError::PasswordTooShort);
    }
    Ok(())
}

/// Persisted brute force state (written to `.securenotes/brute_force.json`).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedBruteForce {
    failed_attempts: u32,
    last_attempt_epoch_secs: Option<u64>,
}

const BRUTE_FORCE_FILE: &str = ".securenotes/brute_force.json";

/// Internal state protected by a single mutex to avoid TOCTOU races.
struct BruteForceState {
    failed_attempts: u32,
    /// Attempts that passed [`BruteForceGuard::begin_attempt`] and have not
    /// yet finished. Counted toward the threshold: without it, N concurrent
    /// unlock calls all pass the check while `failed_attempts` is still below
    /// it, and the guard throttles nothing until every one of them has
    /// reported back.
    in_flight: u32,
    last_attempt: Option<Instant>,
    /// Vault directory for persistence (set on first load).
    vault_dir: Option<std::path::PathBuf>,
}

/// Tracks failed unlock attempts for brute force protection.
pub struct BruteForceGuard {
    state: Mutex<BruteForceState>,
}

/// One unlock attempt that has passed the guard and is now running.
///
/// Held by the unlock command until it returns. Dropping it releases the
/// in-flight slot, so a caller that leaves early (missing vault, keychain
/// error, cancelled prompt) cannot leave the guard believing an attempt is
/// still running.
#[must_use = "bind the attempt for as long as the unlock is in progress"]
pub struct Attempt<'a> {
    guard: &'a BruteForceGuard,
}

impl Drop for Attempt<'_> {
    fn drop(&mut self) {
        self.guard.end_attempt();
    }
}

impl BruteForceGuard {
    /// Create a guard with a clean slate (zero failures). Call [`Self::load_from_disk`]
    /// afterwards to restore any persisted throttle state for a specific vault.
    pub fn new() -> Self {
        Self {
            state: Mutex::new(BruteForceState {
                failed_attempts: 0,
                in_flight: 0,
                last_attempt: None,
                vault_dir: None,
            }),
        }
    }

    /// Load persisted brute force state from disk. Call this on vault unlock.
    pub fn load_from_disk(&self, vault_dir: &Path) {
        let path = vault_dir.join(BRUTE_FORCE_FILE);
        let Ok(mut s) = self.state.lock() else { return };
        s.vault_dir = Some(vault_dir.to_path_buf());

        if let Ok(data) = std::fs::read_to_string(&path) {
            if let Ok(persisted) = serde_json::from_str::<PersistedBruteForce>(&data) {
                s.failed_attempts = persisted.failed_attempts;
                if let Some(epoch) = persisted.last_attempt_epoch_secs {
                    // Convert epoch to Instant (approximate — Instant has no from_epoch)
                    let now_epoch = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs();
                    if epoch < now_epoch {
                        let elapsed = Duration::from_secs(now_epoch - epoch);
                        s.last_attempt = Instant::now().checked_sub(elapsed);
                    }
                }
            }
        }
    }

    /// Persist current state to disk (best-effort).
    fn save_to_disk(s: &BruteForceState) {
        let Some(ref vault_dir) = s.vault_dir else {
            return;
        };
        let persisted = PersistedBruteForce {
            failed_attempts: s.failed_attempts,
            last_attempt_epoch_secs: s.last_attempt.map(|last| {
                let elapsed = last.elapsed();
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs()
                    .saturating_sub(elapsed.as_secs())
            }),
        };
        if let Ok(json) = serde_json::to_string_pretty(&persisted) {
            let path = vault_dir.join(BRUTE_FORCE_FILE);
            // Best-effort write with restricted permissions
            let _ = super::init::write_restricted(&path, json.as_bytes());
        }
    }

    /// Check if the user must wait before attempting again.
    /// Returns Ok(()) if they can proceed, or Err with the wait time.
    #[allow(dead_code)]
    pub fn check_delay(&self) -> Result<(), VaultError> {
        let s = self.state.lock().map_err(|_| VaultError::LockPoisoned)?;
        if s.failed_attempts < MAX_ATTEMPTS_BEFORE_DELAY {
            return Ok(());
        }

        let delay_secs = Self::delay_for_attempt(s.failed_attempts);
        if let Some(last) = s.last_attempt {
            let elapsed = last.elapsed();
            let required = Duration::from_secs(delay_secs);
            if elapsed < required {
                let remaining = (required - elapsed).as_secs() + 1;
                return Err(VaultError::BruteForceDelay(remaining));
            }
        }

        Ok(())
    }

    /// Atomically check the delay AND stamp `last_attempt` to close the TOCTOU
    /// window between check_delay() and record_failure(). A concurrent caller
    /// will see the updated timestamp and be forced to wait.
    ///
    /// The returned [`Attempt`] must be held for as long as the unlock is in
    /// progress: it is what counts the attempt as in flight, and dropping it
    /// (on any return path) releases the slot.
    pub fn begin_attempt(&self) -> Result<Attempt<'_>, VaultError> {
        let mut s = self.state.lock().map_err(|_| VaultError::LockPoisoned)?;
        let pending = s.failed_attempts.saturating_add(s.in_flight);
        if pending >= MAX_ATTEMPTS_BEFORE_DELAY {
            let delay_secs = Self::delay_for_attempt(pending);
            if let Some(last) = s.last_attempt {
                let elapsed = last.elapsed();
                let required = Duration::from_secs(delay_secs);
                if elapsed < required {
                    let remaining = (required - elapsed).as_secs() + 1;
                    return Err(VaultError::BruteForceDelay(remaining));
                }
            }
        }
        // Stamp the attempt time so concurrent callers see it immediately
        s.last_attempt = Some(Instant::now());
        s.in_flight = s.in_flight.saturating_add(1);
        Ok(Attempt { guard: self })
    }

    fn end_attempt(&self) {
        if let Ok(mut s) = self.state.lock() {
            s.in_flight = s.in_flight.saturating_sub(1);
        }
    }

    /// Record a failed attempt and persist to disk.
    pub fn record_failure(&self) {
        let Ok(mut s) = self.state.lock() else { return };
        s.failed_attempts += 1;
        s.last_attempt = Some(Instant::now());
        Self::save_to_disk(&s);
    }

    /// Reset on successful unlock and persist to disk.
    pub fn record_success(&self) {
        let Ok(mut s) = self.state.lock() else { return };
        s.failed_attempts = 0;
        s.last_attempt = None;
        Self::save_to_disk(&s);
    }

    /// Progressive delay: 1s, 2s, 4s, 8s, 16s... after the 5th failure.
    fn delay_for_attempt(attempts: u32) -> u64 {
        if attempts < MAX_ATTEMPTS_BEFORE_DELAY {
            return 0;
        }
        let exponent = attempts - MAX_ATTEMPTS_BEFORE_DELAY;
        1u64 << exponent.min(10) // Cap at ~1024s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_too_short() {
        assert!(validate_password("short").is_err());
        assert!(validate_password("11-chars!!!").is_err());
    }

    #[test]
    fn password_valid() {
        assert!(validate_password("12-characters").is_ok());
        assert!(validate_password("a-very-long-secure-password").is_ok());
    }

    #[test]
    fn brute_force_no_delay_initially() {
        let guard = BruteForceGuard::new();
        assert!(guard.check_delay().is_ok());
    }

    #[test]
    fn brute_force_no_delay_under_threshold() {
        let guard = BruteForceGuard::new();
        for _ in 0..4 {
            guard.record_failure();
        }
        assert!(guard.check_delay().is_ok());
    }

    #[test]
    fn brute_force_delay_after_threshold() {
        let guard = BruteForceGuard::new();
        for _ in 0..5 {
            guard.record_failure();
        }
        // Should require a delay now
        assert!(guard.check_delay().is_err());
    }

    #[test]
    fn brute_force_reset_on_success() {
        let guard = BruteForceGuard::new();
        for _ in 0..5 {
            guard.record_failure();
        }
        guard.record_success();
        assert!(guard.check_delay().is_ok());
    }

    #[test]
    fn progressive_delay_values() {
        assert_eq!(BruteForceGuard::delay_for_attempt(4), 0);
        assert_eq!(BruteForceGuard::delay_for_attempt(5), 1); // 2^0
        assert_eq!(BruteForceGuard::delay_for_attempt(6), 2); // 2^1
        assert_eq!(BruteForceGuard::delay_for_attempt(7), 4); // 2^2
        assert_eq!(BruteForceGuard::delay_for_attempt(8), 8); // 2^3
    }

    /// Five concurrent attempts fill the threshold on their own: the sixth is
    /// refused while the first five are still running, even though no failure
    /// has been recorded yet.
    #[test]
    fn attempts_in_flight_count_toward_the_threshold() {
        let guard = BruteForceGuard::new();
        let held: Vec<Attempt<'_>> = (0..5).map(|_| guard.begin_attempt().unwrap()).collect();
        assert!(
            matches!(guard.begin_attempt(), Err(VaultError::BruteForceDelay(_))),
            "a sixth concurrent attempt must wait"
        );
        drop(held);
        // With every slot released and no failure recorded, the next attempt
        // proceeds at once.
        assert!(guard.begin_attempt().is_ok());
    }

    /// An attempt that ends without reporting a result still gives its slot
    /// back, so an early return cannot wedge the guard.
    #[test]
    fn a_dropped_attempt_frees_its_slot() {
        let guard = BruteForceGuard::new();
        for _ in 0..20 {
            let attempt = guard.begin_attempt().unwrap();
            drop(attempt);
        }
        assert!(guard.begin_attempt().is_ok());
    }

    /// Biometric unlock shares the same BruteForceGuard as password unlock.
    /// This test verifies the guard blocks after repeated failures and that the
    /// error can be mapped to the biometric error type.
    #[test]
    fn brute_force_guard_blocks_biometric_after_threshold() {
        use crate::biometric::error::BiometricError;

        let guard = BruteForceGuard::new();

        // Simulate 5 failed biometric attempts (stale key, etc.)
        for _ in 0..5 {
            guard.record_failure();
        }

        // Guard should now block
        let result = guard.check_delay();
        assert!(result.is_err());

        // Map VaultError → BiometricError (same logic as check_brute_force helper)
        let bio_err = result.map_err(|e| match e {
            VaultError::BruteForceDelay(secs) => BiometricError::BruteForceDelay(secs),
            other => BiometricError::AuthFailed(other.to_string()),
        });
        assert!(bio_err.is_err());
        match bio_err.unwrap_err() {
            BiometricError::BruteForceDelay(secs) => assert!(secs > 0),
            other => panic!("Expected BruteForceDelay, got: {other:?}"),
        }

        // Success resets the guard
        guard.record_success();
        assert!(guard.check_delay().is_ok());
    }
}
