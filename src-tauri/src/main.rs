// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Binary entry point for the Claspt desktop app.
//!
//! Thin wrapper that first gives the CLI a chance to handle a subcommand or
//! `--mcp` flag (via [`claspt_lib::cli::run_cli`]); if no CLI command was
//! matched it launches the Tauri GUI through [`claspt_lib::run`]. All real
//! logic lives in the library crate (`lib.rs`).

fn main() {
    // Check for CLI subcommands or --mcp before launching GUI
    match claspt_lib::cli::run_cli() {
        Ok(true) => return, // CLI command handled
        Ok(false) => {}     // No CLI command, launch GUI
        Err(e) => {
            eprintln!("Error: {e}");
            std::process::exit(1);
        }
    }

    claspt_lib::run();
}
