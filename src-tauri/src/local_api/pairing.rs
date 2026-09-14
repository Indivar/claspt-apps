// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! One-shot pairing so the browser extension can obtain a token without the
//! user copying one.
//!
//! Before this, connecting the extension meant finding Settings, generating a
//! token, and pasting it into the extension's options page. On a fresh install
//! there was no token to find, so the extension simply could not be connected —
//! which is what was reported as "the Windows build does not link".
//!
//! ## How it works
//!
//! 1. The user asks the app to connect (a button in the wizard or Settings),
//!    which ARMS pairing for a short window.
//! 2. The extension, finding it has no token, calls `POST /api/pair`.
//! 3. While armed, that endpoint returns the token once and disarms.
//!
//! ## Why this is acceptable
//!
//! `/api/pair` cannot require a token — obtaining one is the point — so during
//! the armed window any process on this machine could call it and receive the
//! token. That is a real widening, and it is bounded deliberately:
//!
//! - The window only opens when the user asks for it, and closes after
//!   [`PAIRING_WINDOW`] or on the first successful pair, whichever is sooner.
//! - The endpoint is bound to loopback like the rest of the API, so nothing off
//!   this machine can reach it.
//! - The attacker it admits — a process already running as this user — can
//!   already read the token from the OS keychain, so the window grants nothing
//!   that was previously out of reach.
//!
//! What it must never become is a standing endpoint that hands out tokens on
//! request. If the window is ever lengthened, or armed anywhere other than a
//! deliberate user action, that reasoning no longer holds.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use super::auth::TokenScope;

/// How long a pairing window stays open. Long enough to click the extension's
/// icon, short enough that an unattended machine is not left offering tokens.
pub const PAIRING_WINDOW: Duration = Duration::from_secs(120);

/// The armed-or-not state of extension pairing. Tauri-managed, one per app.
pub struct PairingState {
    inner: Mutex<Option<Armed>>,
}

struct Armed {
    /// When the window closes.
    expires_at: Instant,
    /// The scope the paired client will receive.
    scope: TokenScope,
}

/// What a caller learns about the current pairing window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairingStatus {
    pub armed: bool,
    pub seconds_left: u64,
}

impl PairingState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }

    /// Open a pairing window. Re-arming replaces any window already open rather
    /// than extending it, so the total exposure cannot be stretched by repeated
    /// calls.
    pub fn arm(&self, scope: TokenScope) {
        if let Ok(mut guard) = self.lock() {
            *guard = Some(Armed {
                expires_at: Instant::now() + PAIRING_WINDOW,
                scope,
            });
        }
    }

    /// Close the window without pairing.
    pub fn disarm(&self) {
        if let Ok(mut guard) = self.lock() {
            *guard = None;
        }
    }

    pub fn status(&self) -> PairingStatus {
        match self.lock().ok().and_then(|mut g| Self::live(&mut g)) {
            Some(remaining) => PairingStatus {
                armed: true,
                seconds_left: remaining.as_secs(),
            },
            None => PairingStatus {
                armed: false,
                seconds_left: 0,
            },
        }
    }

    /// Consume the window, returning the scope to issue.
    ///
    /// Returns `None` when no window is open or it has expired. Success closes
    /// the window: a pairing window is good for exactly one client, so a second
    /// caller racing the first gets nothing.
    pub fn consume(&self) -> Option<TokenScope> {
        let mut guard = self.lock().ok()?;
        Self::live(&mut guard)?;
        guard.take().map(|armed| armed.scope)
    }

    /// Borrow the state, recovering from a lock poisoned by an earlier panic
    /// rather than propagating it — a poisoned lock must not leave pairing
    /// permanently stuck open.
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Option<Armed>>, ()> {
        Ok(self.inner.lock().unwrap_or_else(|e| e.into_inner()))
    }

    /// Time left on the window, clearing it if it has expired.
    fn live(guard: &mut Option<Armed>) -> Option<Duration> {
        let expires_at = guard.as_ref()?.expires_at;
        match expires_at.checked_duration_since(Instant::now()) {
            Some(remaining) if !remaining.is_zero() => Some(remaining),
            _ => {
                *guard = None;
                None
            }
        }
    }
}

impl Default for PairingState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairing_is_closed_until_the_user_asks_for_it() {
        let state = PairingState::new();
        assert!(!state.status().armed);
        assert_eq!(
            state.consume(),
            None,
            "a token must not be issued without a window"
        );
    }

    #[test]
    fn an_armed_window_issues_the_requested_scope_once() {
        let state = PairingState::new();
        state.arm(TokenScope::Secrets);

        assert!(state.status().armed);
        assert_eq!(state.consume(), Some(TokenScope::Secrets));

        // One window, one client. A second caller gets nothing, so a process
        // racing the extension cannot also collect a token.
        assert_eq!(state.consume(), None);
        assert!(!state.status().armed);
    }

    #[test]
    fn the_scope_asked_for_is_the_scope_issued() {
        let state = PairingState::new();
        state.arm(TokenScope::Notes);
        assert_eq!(state.consume(), Some(TokenScope::Notes));
    }

    #[test]
    fn disarming_closes_the_window() {
        let state = PairingState::new();
        state.arm(TokenScope::Secrets);
        state.disarm();
        assert!(!state.status().armed);
        assert_eq!(state.consume(), None);
    }

    #[test]
    fn re_arming_replaces_the_window_rather_than_extending_it() {
        let state = PairingState::new();
        state.arm(TokenScope::Secrets);
        let first = state.status().seconds_left;
        state.arm(TokenScope::Notes);
        let second = state.status().seconds_left;

        // The clock restarts, it does not accumulate.
        assert!(second <= PAIRING_WINDOW.as_secs());
        assert!(first <= PAIRING_WINDOW.as_secs());
        // And the newer request wins.
        assert_eq!(state.consume(), Some(TokenScope::Notes));
    }

    #[test]
    fn an_expired_window_issues_nothing() {
        let state = PairingState::new();
        // Reach past the public API to age the window, so the test does not
        // have to wait two minutes to prove expiry is enforced.
        {
            let mut guard = state.lock().unwrap();
            *guard = Some(Armed {
                expires_at: Instant::now() - Duration::from_secs(1),
                scope: TokenScope::Secrets,
            });
        }
        assert!(!state.status().armed);
        assert_eq!(state.consume(), None);
    }
}
