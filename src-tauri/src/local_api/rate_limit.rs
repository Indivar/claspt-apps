// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Per-client limit on how many secrets can be decrypted per minute.
//!
//! An agent in a loop, or one under prompt injection, could read every
//! credential in the vault in the time it takes a person to notice the
//! activity list scrolling. The limit is a brake, not a lock: a client that
//! reads more secrets than the vault allows in a minute is told to wait, with
//! a `Retry-After`, and the attempt is in the access log with its name on it.
//! The number is the vault's `secret_read_rate_limit_per_minute` (15 unless
//! the user changes it; the owner wanted it adjustable in both directions).
//!
//! A sliding one-minute window per client, in memory. It resets when the app
//! restarts, which is fine: the log is the durable record, this is the brake.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const WINDOW: Duration = Duration::from_secs(60);

/// Managed by Tauri, one per app.
pub struct SecretReadLimiter {
    windows: Mutex<HashMap<String, VecDeque<Instant>>>,
}

/// Why a read was refused: how long until the oldest read in the window
/// falls out of it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetryAfter {
    pub seconds: u64,
}

impl Default for SecretReadLimiter {
    fn default() -> Self {
        Self::new()
    }
}

impl SecretReadLimiter {
    pub fn new() -> Self {
        Self {
            windows: Mutex::new(HashMap::new()),
        }
    }

    /// Count one secret read for `client_id` at `now`, unless the client has
    /// already made `limit_per_minute` in the last minute. Returns how many
    /// reads the window now holds (this one included) or how long to wait.
    pub fn record(
        &self,
        client_id: &str,
        limit_per_minute: u32,
        now: Instant,
    ) -> Result<u32, RetryAfter> {
        let mut windows = self.windows.lock().unwrap_or_else(|e| e.into_inner());
        let window = windows.entry(client_id.to_string()).or_default();
        while window
            .front()
            .is_some_and(|t| now.duration_since(*t) >= WINDOW)
        {
            window.pop_front();
        }
        let limit = limit_per_minute.max(1) as usize;
        if window.len() >= limit {
            let oldest = *window.front().expect("non-empty when at the limit");
            let wait = WINDOW.saturating_sub(now.duration_since(oldest));
            return Err(RetryAfter {
                seconds: wait.as_secs().max(1),
            });
        }
        window.push_back(now);
        Ok(window.len() as u32)
    }

    /// How many secret reads `client_id` made in the last minute, for the
    /// approval prompt's burst indicator. Does not count anything.
    pub fn recent(&self, client_id: &str, now: Instant) -> u32 {
        let windows = self.windows.lock().unwrap_or_else(|e| e.into_inner());
        windows
            .get(client_id)
            .map(|w| {
                w.iter()
                    .filter(|t| now.duration_since(**t) < WINDOW)
                    .count() as u32
            })
            .unwrap_or(0)
    }

    /// Forget every window, on vault lock.
    pub fn clear(&self) {
        self.windows
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_limit_is_per_client_and_per_minute() {
        let limiter = SecretReadLimiter::new();
        let t0 = Instant::now();
        for i in 1..=3 {
            assert_eq!(limiter.record("a", 3, t0).unwrap(), i);
        }
        let refused = limiter
            .record("a", 3, t0 + Duration::from_secs(10))
            .unwrap_err();
        assert_eq!(
            refused.seconds, 50,
            "wait until the oldest read leaves the window"
        );
        // Another client is unaffected.
        assert!(limiter.record("b", 3, t0).is_ok());
        assert_eq!(limiter.recent("a", t0), 3);
        assert_eq!(limiter.recent("b", t0), 1);
        assert_eq!(limiter.recent("nobody", t0), 0);
        // Once the window has moved on, reads are allowed again.
        assert!(limiter.record("a", 3, t0 + WINDOW).is_ok());
    }

    #[test]
    fn a_limit_of_zero_still_allows_one_read_and_retry_after_is_never_zero() {
        let limiter = SecretReadLimiter::new();
        let t0 = Instant::now();
        assert!(limiter.record("a", 0, t0).is_ok());
        let refused = limiter
            .record("a", 0, t0 + Duration::from_millis(59_900))
            .unwrap_err();
        assert!(refused.seconds >= 1);
    }

    #[test]
    fn clear_forgets_every_window() {
        let limiter = SecretReadLimiter::new();
        let t0 = Instant::now();
        limiter.record("a", 1, t0).unwrap();
        assert!(limiter.record("a", 1, t0).is_err());
        limiter.clear();
        assert!(limiter.record("a", 1, t0).is_ok());
    }
}
