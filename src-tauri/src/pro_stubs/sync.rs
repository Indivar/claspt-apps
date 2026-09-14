// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Sync is not part of the public tree. `/api/status` asks for the sync
//! version; here there is none.

pub mod v2 {
    use std::path::Path;

    #[derive(Debug, Clone)]
    pub struct SyncStateV2 {
        pub last_synced_version: u64,
    }

    pub fn read_sync_state(_vault_dir: &Path) -> Result<Option<SyncStateV2>, String> {
        Ok(None)
    }
}
