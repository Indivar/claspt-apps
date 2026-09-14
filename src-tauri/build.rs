// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Cargo build script for the Claspt Tauri crate.
//!
//! Runs before compilation to inject the app version and invoke Tauri's own
//! build step. The version is read from the workspace `package.json` (the
//! single source of truth) and exported as the `APP_VERSION` compile-time env
//! var so Rust code can read it via `env!("APP_VERSION")`. A `rerun-if-changed`
//! directive ensures a version bump in `package.json` triggers a rebuild.

use std::fs;

fn main() {
    // Read version from package.json (single source of truth)
    let pkg_json = fs::read_to_string("../package.json").expect("failed to read package.json");
    let pkg: serde_json::Value =
        serde_json::from_str(&pkg_json).expect("failed to parse package.json");
    let version = pkg["version"]
        .as_str()
        .expect("missing version in package.json");

    println!("cargo:rustc-env=APP_VERSION={}", version);
    // Re-run if package.json changes
    println!("cargo:rerun-if-changed=../package.json");

    tauri_build::build()
}
