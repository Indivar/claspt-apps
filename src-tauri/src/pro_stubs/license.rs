// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! The licence system is not part of the public tree. This is what the
//! rest of the app needs from it: a status that says nothing is licensed,
//! so every feature the public build has is simply available.

pub mod validator {
    use std::path::Path;

    #[derive(Debug, Clone, Default)]
    pub struct LicenseState;

    #[derive(Debug, Clone, serde::Serialize)]
    pub struct LicenseStatus {
        pub is_pro: bool,
        pub tier: Option<String>,
        pub email: Option<String>,
        pub expires_at: Option<String>,
        pub days_remaining: Option<i64>,
        pub is_expired: bool,
    }

    pub fn load_license_state(_vault_dir: &Path) -> LicenseState {
        LicenseState
    }

    pub fn validate(_state: &LicenseState) -> LicenseStatus {
        LicenseStatus {
            is_pro: false,
            tier: None,
            email: None,
            expires_at: None,
            days_remaining: None,
            is_expired: false,
        }
    }

    /// Nothing to check: there is no licence server in this build.
    pub fn maybe_online_check(_vault_dir: &Path) {}
}
