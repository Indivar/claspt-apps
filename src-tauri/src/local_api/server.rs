// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! HTTP server lifecycle and router construction for the local API.
//!
//! This is where the localhost API boots. [`start_server`] binds an axum server
//! to `127.0.0.1:{port}`, wires up [`build_router`] (which mounts every route in
//! [`super::routes`] behind the [`super::auth::require_auth`] middleware), and
//! serves until [`stop_server`] fires the graceful-shutdown signal. It is started
//! when the vault is unlocked and the local API is enabled.
//!
//! [`ApiContext`] is the shared, per-server state handed to every route handler:
//! the Tauri `AppHandle` (used to reach managed state like the vault, search, and
//! git) plus the configured bearer tokens for each scope. [`LocalApiState`] is the
//! Tauri-managed handle the rest of the app uses to start/stop the server and
//! query whether it is running and on which port.

use axum::{
    extract::Extension,
    middleware,
    routing::{get, patch, post},
    Router,
};
use std::sync::Mutex;
use tauri::Manager;
use tokio::net::TcpListener;
use tokio::sync::watch;

use super::auth;
use super::routes;
use super::services::Services;

/// Shared context accessible by all Axum route handlers: the host behind
/// the [`Services`] trait, whichever host that is.
#[derive(Clone)]
pub struct ApiContext {
    pub services: std::sync::Arc<dyn Services>,
}

/// Managed state for the local API server lifecycle.
pub struct LocalApiState {
    /// Sender to signal server shutdown (set to true to stop).
    shutdown_tx: Mutex<Option<watch::Sender<bool>>>,
    /// Whether the server is currently running.
    running: Mutex<bool>,
    /// The port the server is running on (0 if not running).
    port: Mutex<u16>,
}

impl LocalApiState {
    /// Create an idle state handle (server not running, no port bound).
    pub fn new() -> Self {
        Self {
            shutdown_tx: Mutex::new(None),
            running: Mutex::new(false),
            port: Mutex::new(0),
        }
    }

    /// Whether the local API server is currently serving requests.
    pub fn is_running(&self) -> bool {
        self.running.lock().ok().map(|g| *g).unwrap_or(false)
    }

    /// The port the server is bound to, or `0` when it is not running.
    pub fn get_port(&self) -> u16 {
        self.port.lock().ok().map(|g| *g).unwrap_or(0)
    }
}

/// Build the Axum router with auth middleware and routes.
fn build_router(ctx: ApiContext) -> Router {
    let shared = std::sync::Arc::new(ctx);

    let api_routes = Router::new()
        .route("/api/status", get(routes::status))
        .route("/api/pages", get(routes::list_pages).post(routes::create_page))
        // All page-scoped routes use a single-segment `{path_or_id}` param;
        // axum forbids catch-all globs (`{*foo}`) anywhere except the last
        // segment of a route, so paths-with-slashes must be URL-encoded by
        // the caller (e.g. `general%2Ffoo.md`). Extension and mobile both
        // already do this via encodeURIComponent.
        .route(
            "/api/pages/{path_or_id}/secret/rename",
            patch(routes::rename_secret_block),
        )
        .route(
            "/api/pages/{path_or_id}/secret",
            get(routes::list_secret_blocks)
                .patch(routes::patch_secret_block)
                .delete(routes::delete_secret_block),
        )
        .route("/api/pages/{path_or_id}/move", patch(routes::move_page_route))
        .route("/api/pages/{path_or_id}/title", patch(routes::update_title_route))
        .route("/api/pages/{path_or_id}/tags", patch(routes::update_tags_route))
        .route("/api/pages/{path_or_id}/pin", patch(routes::pin_route))
        .route("/api/pages/{path_or_id}/archive", patch(routes::archive_route))
        .route(
            "/api/pages/{path_or_id}",
            get(routes::read_page)
                .put(routes::update_page)
                .delete(routes::delete_page),
        )
        .route("/api/search", get(routes::search))
        .route("/api/folders", get(routes::list_folders).post(routes::create_folder))
        .route(
            "/api/folders/{name}",
            patch(routes::rename_folder_route).delete(routes::delete_folder_route),
        )
        // Generator (no vault state needed)
        .route("/api/generate/password", post(routes::gen_password))
        .route("/api/generate/passphrase", post(routes::gen_passphrase))
        .route("/api/generate/memorable", post(routes::gen_memorable))
        .route("/api/generate/pin", post(routes::gen_pin))
        .route("/api/generate/uuid", get(routes::gen_uuid))
        .route("/api/generate/strength", post(routes::gen_strength))
        .route("/api/generate/bulk", post(routes::gen_bulk))
        // Memory routes
        .route("/api/memory", get(routes::memory_list_namespaces))
        .route("/api/memory/cleanup", post(routes::memory_cleanup))
        .route("/api/memory/search", get(routes::memory_search))
        .route(
            "/api/memory/{namespace}",
            get(routes::memory_list).put(routes::memory_upsert),
        )
        .route(
            "/api/memory/{namespace}/bulk",
            post(routes::memory_bulk_upsert),
        )
        .route(
            "/api/memory/{namespace}/{title}/append",
            post(routes::memory_append),
        )
        .route(
            "/api/memory/{namespace}/{title}/verify",
            post(routes::memory_verify),
        )
        .route(
            "/api/memory/{namespace}/{title}/compact",
            post(routes::memory_compact),
        )
        .route(
            "/api/memory/{namespace}/bootstrap",
            post(routes::memory_bootstrap),
        )
        .route(
            "/api/secrets",
            get(routes::find_secrets_route).post(routes::store_secret_route),
        )
        .route("/api/audit/secrets", get(routes::audit_secrets_route))
        .route("/api/audit/rotation", get(routes::audit_rotation_route))
        // Browser login jobs: an agent asks, the owner approves, the paired
        // extension fills. Registered before the page routes so nothing
        // under /api/browser is ever read as a page path.
        .route(
            "/api/browser/login/{page_or_job}",
            post(routes::browser_login).get(routes::browser_login_status),
        )
        .route("/api/browser/jobs", get(routes::browser_jobs_poll))
        .route("/api/ssh/identities", get(routes::ssh_identities))
        .route("/api/passkeys", get(routes::passkey_list))
        .route(
            "/api/passkeys/{rp_id}/register",
            post(routes::passkey_register),
        )
        .route(
            "/api/passkeys/{rp_id}/authenticate",
            post(routes::passkey_authenticate),
        )
        .route(
            "/api/browser/jobs/{job_id}/result",
            post(routes::browser_job_result),
        )
        .route(
            "/api/memory/{namespace}/{title}",
            get(routes::memory_read).delete(routes::memory_delete),
        )
        .layer(middleware::from_fn(auth::require_auth));

    // Pairing sits OUTSIDE the auth layer on purpose: a client with no token
    // cannot present one, and getting a token is what this endpoint is for. Its
    // gate is the short, user-opened pairing window instead — see
    // `local_api::pairing` for why that is an acceptable substitute here.
    let public_routes = Router::new().route("/api/pair", post(routes::pair_route));

    Router::new()
        .merge(api_routes)
        .merge(public_routes)
        .fallback(routes::not_found)
        .layer(Extension(shared))
        // Outermost on purpose: it runs before auth, before pairing, and
        // before the fallback, so a browser page never sees any of them.
        .layer(middleware::from_fn(auth::require_local_origin))
}

/// Start the local HTTP API server.
///
/// Binds to `127.0.0.1:{port}` and serves until the shutdown signal fires.
/// Called when the vault is unlocked and the local API is enabled.
pub async fn start_server(port: u16, app_handle: tauri::AppHandle) -> Result<(), String> {
    let api_state = app_handle.state::<LocalApiState>();

    // Prevent double-start
    {
        let running = api_state
            .running
            .lock()
            .map_err(|_| "lock poisoned".to_string())?;
        if *running {
            return Ok(());
        }
    }

    // Tokens are intentionally NOT captured here. The auth middleware reads them
    // from the client registry on each request, so a token minted or revoked
    // takes effect immediately instead of at the next app restart.
    let services = super::services::tauri_services(app_handle.clone());
    let listener = bind(port).await?;

    // Set up shutdown signal
    let (tx, rx) = watch::channel(false);
    {
        let mut shutdown = api_state
            .shutdown_tx
            .lock()
            .map_err(|_| "lock poisoned".to_string())?;
        *shutdown = Some(tx);
        let mut running = api_state
            .running
            .lock()
            .map_err(|_| "lock poisoned".to_string())?;
        *running = true;
        let mut p = api_state
            .port
            .lock()
            .map_err(|_| "lock poisoned".to_string())?;
        *p = port;
    }

    let result = serve_until(services, listener, rx).await;

    // Clean up
    {
        if let Ok(mut shutdown) = api_state.shutdown_tx.lock() {
            *shutdown = None;
        }
        if let Ok(mut running) = api_state.running.lock() {
            *running = false;
        }
        if let Ok(mut p) = api_state.port.lock() {
            *p = 0;
        }
    }

    log::info!("Local API server stopped");
    result
}

/// Bind the loopback listener. The host is never configurable: the API is
/// for processes on this machine only.
pub async fn bind(port: u16) -> Result<TcpListener, String> {
    let addr = format!("127.0.0.1:{port}");
    let listener = TcpListener::bind(&addr)
        .await
        .map_err(|e| format!("Failed to bind {addr}: {e}"))?;
    log::info!("Local API server started on {addr}");
    Ok(listener)
}

/// Serve the API on `listener` until `shutdown` turns true. Shared by the
/// desktop app and `claspt serve`; the only difference is `services`.
pub async fn serve_until(
    services: std::sync::Arc<dyn Services>,
    listener: TcpListener,
    mut shutdown: watch::Receiver<bool>,
) -> Result<(), String> {
    let router = build_router(ApiContext { services });
    let server = axum::serve(listener, router).with_graceful_shutdown(async move {
        while !*shutdown.borrow_and_update() {
            if shutdown.changed().await.is_err() {
                break;
            }
        }
    });
    server.await.map_err(|e| format!("Server error: {e}"))
}

/// Stop the local HTTP API server.
pub fn stop_server(api_state: &LocalApiState) {
    let Ok(shutdown) = api_state.shutdown_tx.lock() else {
        return;
    };
    if let Some(tx) = shutdown.as_ref() {
        let _ = tx.send(true);
        log::info!("Local API server shutdown signal sent");
    }
}
