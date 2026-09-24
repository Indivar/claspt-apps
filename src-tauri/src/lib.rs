// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Claspt desktop library crate: Tauri app wiring and module map.
//!
//! This crate hosts the Rust backend for the Claspt desktop app. It declares
//! the domain modules, registers the Tauri IPC commands the React frontend
//! calls, sets up shared app state (vault, search, git, sync), and exposes
//! [`run`] which builds and launches the Tauri application. `main.rs` calls
//! into it after the CLI has had its chance.
//!
//! Module map:
//! - [`crypto`] — AES-256-GCM + Argon2id, re-exported from `claspt-core`.
//! - [`vault`] — vault directory, `config.json`, `vault.key`, unlock/lock.
//! - [`pages`] — page CRUD and secret-block parsing/encryption.
//! - [`search`] — tantivy full-text index with field boosts.
//! - [`git`] — auto-commit and version history.
//! - [`sync`] — Pro-only sync engine (legacy + v2 protocol).
//! - [`license`] — Ed25519 offline license/trial validation.
//! - [`import`] / [`utilities`] — data import and vault maintenance tools.
//! - [`biometric`] — Touch ID / Windows Hello unlock via the OS keychain.
//! - [`generator`] — CSPRNG password/passphrase/PIN generation.
//! - [`commands`] — Tauri command handlers bridging the modules to the UI.
//! - [`cli`], [`mcp`], [`local_api`], [`internal`] — CLI, MCP server, local
//!   HTTP API for the browser extension, and internal app-state stores.

pub mod agent_namespace;
mod api_response;
mod biometric;
pub mod cli;
mod commands;
mod crypto;
pub mod generator;
mod git;
mod import;
mod inbox;
pub mod internal;
#[cfg(feature = "pro")]
// rustfmt would otherwise try to open this module, which the public tree does not carry.
#[rustfmt::skip]
mod license;
#[cfg(not(feature = "pro"))]
#[path = "pro_stubs/license.rs"]
mod license;
mod local_api;
pub mod mcp;
pub mod mcp_install;
pub mod memory_import;
mod pages;
mod search;
pub mod secret_ref;
pub mod serve;
#[cfg(feature = "pro")]
#[rustfmt::skip]
mod share;
pub mod ssh_agent;
#[cfg(feature = "pro")]
#[rustfmt::skip]
mod sync;
#[cfg(not(feature = "pro"))]
#[path = "pro_stubs/sync.rs"]
mod sync;
mod utilities;
mod vault;
pub mod webauthn;

use commands::api::{
    approve_secret_access, begin_extension_pairing, cancel_extension_pairing, connect_ai_tool,
    create_api_client, extension_pairing_status, get_exe_path, list_api_clients,
    list_approval_grants, local_api_status, memory_overview, read_access_log, revoke_api_client,
    revoke_approval_grant, ssh_agent_status, start_local_api, start_ssh_agent, stop_local_api,
    stop_ssh_agent,
};
use commands::biometric::{
    biometric_available, biometric_disable, biometric_enroll, biometric_enrolled, biometric_status,
    biometric_unlock, biometric_verify,
};
use commands::crypto::{
    change_master_password, create_vault, decrypt_block, encrypt_block, get_vault_config,
    inspect_vault_dir, key_lock_vault, lock_vault, print_window, recover_with_key,
    recovery_key_filename, reset_to_defaults, save_recovery_key, set_vault_config,
    suggest_default_vault_dir, touch_activity, unlock_vault, vault_exists_at, verify_password,
    VaultState,
};
use commands::export::{export_secrets_only, export_vault_complete, import_from_zip};
use commands::generator::{
    check_password_strength, export_generated, generate_bulk, generate_memorable,
    generate_passphrase, generate_password, generate_pin, generate_uuid,
};
use commands::git::{
    git_commit, git_commit_diff, git_file_at_commit, git_file_log, git_log, git_restore_to_commit,
    GitState,
};
use commands::import::{
    detect_csv_columns, execute_import, import_markdown_page, preview_import,
    preview_markdown_import,
};
use commands::internal::{
    add_security_alert, delete_automation_rule, delete_template, dismiss_security_alert,
    find_stale_credentials, get_all_security_alerts, get_automation_rules, get_devices,
    get_extension_prefs, get_health_history, get_import_history, get_latest_health,
    get_recently_used, get_security_alerts, get_templates, get_usage_journal, get_vault_stats,
    log_credential_usage, log_import, post_unlock_init, register_device, remove_device,
    resolve_security_alert, run_security_scan, save_automation_rule, save_extension_prefs,
    save_health_snapshot, save_template, save_vault_stats_snapshot, toggle_automation_rule,
};
use commands::pages::{
    create_folder, create_page, delete_folder, delete_media, delete_page, delete_pages_bulk,
    duplicate_page, export_media, list_folders, list_pages, list_secrets, list_tags,
    media_references, media_usage, move_page, preview_image_transform,
    preview_image_transform_bytes, process_and_save_media, process_and_save_media_bytes,
    read_media_data_url, read_page, rename_folder, resolve_media_path, save_media,
    save_media_from_path, set_media_sealed, set_memory_reviewed, stat_source_file, toggle_archive,
    toggle_encryption, toggle_pin, trash_empty, trash_list, trash_purge, trash_restore,
    update_page, update_tags, update_title,
};
use commands::passkeys::{delete_passkey, list_passkeys};
use commands::search::{rebuild_search_index, search_pages, SearchState};
use commands::sync::{SyncState, SyncV2Managed};
use commands::utilities::{
    utility_breach_check, utility_bulk_tag_operation, utility_consolidate_execute,
    utility_consolidate_preview, utility_find_duplicates, utility_import_folder,
    utility_list_tags_usage, utility_password_health, utility_reset_help_pages,
    utility_rotation_due, utility_vault_stats,
};
use local_api::{ApprovalManager, LocalApiState};

use std::fs::OpenOptions;
use std::io::Write;
use std::panic;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager};

/// Set up a panic handler that writes crash info to a log file.
fn install_panic_handler() {
    let default_hook = panic::take_hook();
    panic::set_hook(Box::new(move |info| {
        let crash_msg = format!(
            "[{}] PANIC: {}\nLocation: {}\n\n",
            chrono::Utc::now().to_rfc3339(),
            info.payload()
                .downcast_ref::<&str>()
                .copied()
                .or_else(|| info.payload().downcast_ref::<String>().map(|s| s.as_str()))
                .unwrap_or("unknown"),
            info.location()
                .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
                .unwrap_or_else(|| "unknown".to_string()),
        );

        // Try to write to crash log in home dir
        if let Some(home) = dirs::home_dir() {
            let log_path = home.join(".claspt-crash.log");
            if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&log_path) {
                let _ = f.write_all(crash_msg.as_bytes());
            }
        }

        // Also log to stderr
        eprintln!("{}", crash_msg);

        // Call default hook (prints backtrace etc.)
        default_hook(info);
    }));
}

/// On Windows, detect and clear corrupted WebView2 data to prevent crash loops.
/// Uses a crash marker file: set before startup, cleared after successful startup.
/// If the marker exists on launch, WebView2 data is corrupted — clear it.
#[cfg(target_os = "windows")]
fn recover_webview2_data() {
    let Some(data_dir) = dirs::data_dir().map(|d| d.join("in.indivar.claspt")) else {
        return;
    };

    let webview_dir = data_dir.join("EBWebView");
    if !webview_dir.exists() {
        return;
    }

    let marker = data_dir.join(".webview2-crash-marker");
    if marker.exists() {
        eprintln!("Claspt: clearing corrupted WebView2 data after repeated crash");
        if let Err(e) = std::fs::remove_dir_all(&webview_dir) {
            eprintln!("Claspt: failed to clear WebView2 data: {e}");
        }
        let _ = std::fs::remove_file(&marker);
        return;
    }

    // Set crash marker — cleared after successful startup
    let _ = std::fs::write(&marker, "");
}

/// Clear the WebView2 crash marker after successful startup.
#[cfg(target_os = "windows")]
fn clear_webview2_crash_marker() {
    if let Some(data_dir) = dirs::data_dir().map(|d| d.join("in.indivar.claspt")) {
        let _ = std::fs::remove_file(data_dir.join(".webview2-crash-marker"));
    }
}

/// Every IPC command, in one list. The commercial commands are appended by
/// the caller so the public list is written once and the two builds differ
/// only in what follows it.
macro_rules! invoke_handlers {
    ($($pro:ident),* $(,)?) => {
        tauri::generate_handler![
            list_passkeys,
            delete_passkey,
            create_vault,
            unlock_vault,
            lock_vault,
            key_lock_vault,
            touch_activity,
            verify_password,
            recover_with_key,
            change_master_password,
            recovery_key_filename,
            save_recovery_key,
            print_window,
            get_vault_config,
            set_vault_config,
            reset_to_defaults,
            suggest_default_vault_dir,
            vault_exists_at,
            inspect_vault_dir,
            encrypt_block,
            decrypt_block,
            create_page,
            read_page,
            update_page,
            delete_page,
            delete_pages_bulk,
            trash_list,
            trash_restore,
            trash_purge,
            trash_empty,
            duplicate_page,
            toggle_pin,
            toggle_archive,
            set_memory_reviewed,
            toggle_encryption,
            list_pages,
            list_secrets,
            list_tags,
            move_page,
            list_folders,
            create_folder,
            rename_folder,
            delete_folder,
            update_tags,
            update_title,
            save_media,
            save_media_from_path,
            delete_media,
            resolve_media_path,
            read_media_data_url,
            preview_image_transform,
            preview_image_transform_bytes,
            process_and_save_media,
            process_and_save_media_bytes,
            set_media_sealed,
            media_references,
            media_usage,
            stat_source_file,
            export_media,
            search_pages,
            rebuild_search_index,
            git_commit,
            git_log,
            git_file_log,
            git_file_at_commit,
            git_commit_diff,
            git_restore_to_commit,
            detect_csv_columns,
            preview_import,
            execute_import,
            preview_markdown_import,
            import_markdown_page,
            biometric_available,
            biometric_enrolled,
            biometric_enroll,
            biometric_unlock,
            biometric_verify,
            biometric_disable,
            biometric_status,
            start_local_api,
            stop_local_api,
            list_api_clients,
            create_api_client,
            revoke_api_client,
            read_access_log,
            list_approval_grants,
            revoke_approval_grant,
            memory_overview,
            start_ssh_agent,
            stop_ssh_agent,
            ssh_agent_status,
            begin_extension_pairing,
            cancel_extension_pairing,
            extension_pairing_status,
            approve_secret_access,
            local_api_status,
            get_exe_path,
            connect_ai_tool,
            generate_password,
            generate_passphrase,
            generate_memorable,
            generate_pin,
            generate_uuid,
            check_password_strength,
            generate_bulk,
            export_generated,
            export_vault_complete,
            export_secrets_only,
            import_from_zip,
            utility_vault_stats,
            utility_password_health,
            utility_rotation_due,
            utility_find_duplicates,
            utility_consolidate_preview,
            utility_consolidate_execute,
            utility_list_tags_usage,
            utility_bulk_tag_operation,
            utility_breach_check,
            utility_reset_help_pages,
            utility_import_folder,
            log_credential_usage,
            get_usage_journal,
            get_recently_used,
            find_stale_credentials,
            get_devices,
            register_device,
            remove_device,
            get_security_alerts,
            get_all_security_alerts,
            add_security_alert,
            dismiss_security_alert,
            resolve_security_alert,
            save_health_snapshot,
            get_health_history,
            get_latest_health,
            get_extension_prefs,
            save_extension_prefs,
            get_templates,
            save_template,
            delete_template,
            get_automation_rules,
            save_automation_rule,
            delete_automation_rule,
            toggle_automation_rule,
            get_import_history,
            log_import,
            get_vault_stats,
            save_vault_stats_snapshot,
            post_unlock_init,
            run_security_scan,
            $($pro),*
        ]
    };
}
/// The commercial build's extra commands live in their own module, so this
/// file names the seam and not the features behind it.
#[cfg(feature = "pro")]
#[rustfmt::skip]
mod pro;

/// The IPC handler for this build.
#[cfg(feature = "pro")]
fn invoke_handler() -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool {
    pro::invoke_handler()
}

#[cfg(not(feature = "pro"))]
fn invoke_handler() -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool {
    invoke_handlers![]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_panic_handler();

    #[cfg(target_os = "windows")]
    recover_webview2_data();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Focus the existing window when a second instance is launched
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(local_api::pairing::PairingState::new())
        .manage(VaultState::new())
        .manage(SearchState::new())
        .manage(GitState::new())
        .manage(SyncState::new())
        .manage(SyncV2Managed::new())
        .manage(LocalApiState::new())
        .manage(ApprovalManager::new())
        .manage(local_api::BrowserJobs::new())
        .manage(ssh_agent::SshAgentState::new())
        .manage(local_api::SecretReadLimiter::new())
        .manage(inbox::InboxState::new())
        .invoke_handler(invoke_handler())
        .setup(|app| {
            // Register updater plugin (excluded in store builds via --no-default-features)
            #[cfg(feature = "updater")]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;

            // Enable logging in both debug and release
            let log_level = if cfg!(debug_assertions) {
                log::LevelFilter::Debug
            } else {
                log::LevelFilter::Info
            };

            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log_level)
                    // Suppress verbose tantivy segment-level logging
                    .level_for("tantivy", log::LevelFilter::Warn)
                    .level_for("tantivy::indexer", log::LevelFilter::Warn)
                    .level_for("tantivy::directory", log::LevelFilter::Warn)
                    // Support needs more than the last few hours. The default
                    // is one 40 KB file that rotated away yesterday's evidence
                    // by breakfast; five dated files of 2 MB keep about a week.
                    .max_file_size(2_000_000)
                    .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(5))
                    .target(tauri_plugin_log::Target::new(
                        tauri_plugin_log::TargetKind::LogDir {
                            file_name: Some("claspt.log".into()),
                        },
                    ))
                    .build(),
            )?;

            // System tray
            let open_item = MenuItemBuilder::new("Open Claspt")
                .id("tray_open")
                .build(app)?;
            let lock_item = MenuItemBuilder::new("Lock Vault")
                .id("tray_lock")
                .build(app)?;
            let api_item = MenuItemBuilder::new("API: checking...")
                .id("tray_api_status")
                .enabled(false)
                .build(app)?;
            let quit_item = MenuItemBuilder::new("Quit").id("tray_quit").build(app)?;

            let tray_menu = MenuBuilder::new(app)
                .items(&[&open_item, &lock_item, &api_item, &quit_item])
                .build()?;

            TrayIconBuilder::new()
                .menu(&tray_menu)
                .tooltip("Claspt")
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "tray_open" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
                    "tray_lock" => {
                        let _ = app.emit("vault-lock-requested", ());
                    }
                    "tray_quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            log::info!("Claspt v{} started", env!("APP_VERSION"));

            // Open devtools in debug builds only
            #[cfg(debug_assertions)]
            if let Some(w) = app.get_webview_window("main") {
                w.open_devtools();
            }

            #[cfg(target_os = "windows")]
            clear_webview2_crash_marker();

            // Auto-start local API on app launch if enabled in config.
            // Reads config from default vault dir — server stays up across lock/unlock cycles.
            {
                // The last vault opened, when there is one, because a person
                // who keeps their vault outside the default directory would
                // otherwise have the default vault's settings answer for it.
                use tauri::Manager;
                let vault_dir = app
                    .path()
                    .app_config_dir()
                    .ok()
                    .and_then(|dir| vault::last_opened::recall(&dir))
                    .unwrap_or_else(|| std::path::PathBuf::from(suggest_default_vault_dir()));
                let config_path = vault_dir.join(".securenotes").join("config.json");
                if config_path.exists() {
                    if let Ok(cfg) = vault::init::read_config(&vault_dir) {
                        // Clients live in the registry, not in the config,
                        // so "enabled" is the only condition: with no client
                        // yet, the auth layer refuses every request.
                        if cfg.local_api_enabled == Some(true) {
                            let port = cfg.local_api_port;
                            let handle = app.handle().clone();
                            tauri::async_runtime::spawn(async move {
                                if let Err(e) = local_api::server::start_server(port, handle).await
                                {
                                    log::error!("Local API auto-start on launch failed: {e}");
                                }
                            });
                            log::info!("Local API auto-starting on port {port} (app launch)");
                        }
                        if cfg.ssh_agent_enabled == Some(true) {
                            if let Err(e) = app
                                .state::<ssh_agent::SshAgentState>()
                                .start(local_api::tauri_services(app.handle().clone()))
                            {
                                log::error!("SSH agent auto-start on launch failed: {e}");
                            }
                        }
                    }
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| {
            log::error!("Fatal: Tauri application failed to start: {e}");
            eprintln!("Fatal: Tauri application failed to start: {e}");

            // Write to crash log for diagnosis
            if let Some(home) = dirs::home_dir() {
                let log_path = home.join(".claspt-crash.log");
                if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&log_path) {
                    let msg = format!(
                        "[{}] STARTUP FAILURE: {e}\n\n",
                        chrono::Utc::now().to_rfc3339()
                    );
                    let _ = f.write_all(msg.as_bytes());
                }
            }
        });
}
