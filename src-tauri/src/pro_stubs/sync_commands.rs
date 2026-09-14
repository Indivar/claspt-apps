// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! The managed state and unlock hooks the vault commands expect from the
//! sync module, for a build that has no sync. Starting is a logged no-op,
//! never a silent one: a config that asks for remote sync gets told.

/// Managed state; nothing to hold.
pub struct SyncState;

impl Default for SyncState {
    fn default() -> Self {
        Self::new()
    }
}

impl SyncState {
    pub fn new() -> Self {
        Self
    }
}

/// Managed state for Sync V2. The unlock path flips `invalidate` when key
/// material changes; nothing reads it here.
pub struct SyncV2Managed {
    pub invalidate: std::sync::atomic::AtomicBool,
}

impl Default for SyncV2Managed {
    fn default() -> Self {
        Self::new()
    }
}

impl SyncV2Managed {
    pub fn new() -> Self {
        Self {
            invalidate: std::sync::atomic::AtomicBool::new(false),
        }
    }
}

pub fn init_sync_state(
    _vault_dir: &std::path::Path,
    backend: &str,
    _remote_url: Option<&str>,
    _interval_secs: u32,
    _sync_state: &SyncState,
) {
    log::warn!(
        "[sync] this build has no sync; the '{backend}' backend in the vault config is ignored"
    );
}

pub fn close_sync_state(_sync_state: &SyncState) {}
