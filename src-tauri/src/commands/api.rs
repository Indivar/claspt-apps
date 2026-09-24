// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Tauri IPC commands for controlling the local API server.
//!
//! Claspt can expose a loopback-only HTTP API (bound to `127.0.0.1`) so companion
//! tools — the browser extension, an MCP server, or scripts — can read notes and
//! request secrets. These commands let the frontend start/stop that server,
//! manage the named clients whose tokens may call it (see
//! `local_api::clients`), resolve pending secret-access approval prompts, and
//! query server status. All commands operate on the currently open
//! vault; most return `Err("Vault not open")` when no vault is unlocked.

use tauri::{AppHandle, State};

use super::crypto::VaultState;
use crate::local_api::auth::TokenScope;
use crate::local_api::server;
use crate::local_api::{clients, ApprovalManager, LocalApiState};
use crate::vault::init;

/// Start the local API server.
///
/// Reads vault config for the port and configured tokens, then spawns the Axum
/// server on `127.0.0.1:{port}` in a background task. Returns `"already running"`
/// (without restarting) if the server is up, otherwise `"started on port {port}"`.
///
/// Errors: `"Vault not open"` if no vault is unlocked, `"Config read failed: …"`
/// if the config cannot be read.
#[tauri::command]
pub async fn start_local_api(
    app: AppHandle,
    vault_state: State<'_, VaultState>,
    api_state: State<'_, LocalApiState>,
) -> Result<String, String> {
    if api_state.is_running() {
        return Ok("already running".to_string());
    }

    let vault_dir = vault_state.vault_dir().ok_or("Vault not open")?;
    let config = init::read_config(&vault_dir).map_err(|e| format!("Config read failed: {e}"))?;

    // The server starts even with no clients registered: pairing and
    // `claspt mcp install` mint the first one, and until then the auth
    // middleware rejects every request.
    let port = config.local_api_port;
    let handle = app.clone();
    tokio::spawn(async move {
        if let Err(e) = server::start_server(port, handle).await {
            log::error!("Local API server failed: {e}");
        }
    });

    Ok(format!("started on port {port}"))
}

/// Start the SSH agent. Returns the socket (or pipe) path `ssh` should be
/// pointed at with `SSH_AUTH_SOCK`.
#[tauri::command]
pub fn start_ssh_agent(
    app: AppHandle,
    agent: State<crate::ssh_agent::SshAgentState>,
) -> Result<String, String> {
    agent.start(crate::local_api::tauri_services(app))
}

/// Stop the SSH agent. Idempotent.
#[tauri::command]
pub fn stop_ssh_agent(agent: State<crate::ssh_agent::SshAgentState>) -> Result<(), String> {
    agent.stop();
    Ok(())
}

#[derive(serde::Serialize)]
pub struct SshAgentStatus {
    pub running: bool,
    pub socket: String,
}

#[tauri::command]
pub fn ssh_agent_status(
    agent: State<crate::ssh_agent::SshAgentState>,
) -> Result<SshAgentStatus, String> {
    Ok(SshAgentStatus {
        running: agent.is_running(),
        socket: crate::ssh_agent::socket_path()?,
    })
}

/// Stop the local API server. Idempotent — a no-op if it is not running.
#[tauri::command]
pub fn stop_local_api(api_state: State<LocalApiState>) -> Result<(), String> {
    server::stop_server(&api_state);
    Ok(())
}

/// The registered API clients, for the Settings list. Records carry hashes and
/// hints, never tokens: a token is shown once, when it is created.
#[tauri::command]
pub fn list_api_clients(state: State<VaultState>) -> Result<Vec<clients::ClientToken>, String> {
    let vault_dir = state.vault_dir().ok_or("Vault not open")?;
    clients::list(&vault_dir).map_err(|e| format!("Could not read API clients: {e}"))
}

/// Mint a token for a new named client and return it, once.
///
/// `scope` is "notes" or "secrets"; `namespaces` restricts memory access
/// (empty means all). The token in the response is the only copy there will
/// ever be; the registry keeps its hash.
#[tauri::command]
pub fn create_api_client(
    name: String,
    scope: String,
    namespaces: Vec<String>,
    state: State<VaultState>,
) -> Result<serde_json::Value, String> {
    let vault_dir = state.vault_dir().ok_or("Vault not open")?;
    let scope = match scope.as_str() {
        "notes" => TokenScope::Notes,
        "secrets" => TokenScope::Secrets,
        other => {
            return Err(format!(
                "unknown scope '{other}' — expected notes or secrets"
            ))
        }
    };
    let minted = clients::create(&vault_dir, &name, scope, &namespaces)
        .map_err(|e| format!("Could not create API client: {e}"))?;
    Ok(serde_json::json!({
        "token": minted.token.as_str(),
        "client": minted.client,
    }))
}

/// Revoke a client. Its token stops authenticating on the next request.
#[tauri::command]
pub fn revoke_api_client(id: String, state: State<VaultState>) -> Result<bool, String> {
    let vault_dir = state.vault_dir().ok_or("Vault not open")?;
    clients::revoke(&vault_dir, &id).map_err(|e| format!("Could not revoke API client: {e}"))
}

/// The most recent API requests, newest first, optionally for one client.
#[tauri::command]
pub fn read_access_log(
    limit: usize,
    client_id: Option<String>,
    state: State<VaultState>,
) -> Result<Vec<crate::internal::access_log::AccessEntry>, String> {
    let vault_dir = state.vault_dir().ok_or("Vault not open")?;
    crate::internal::access_log::read_recent(&vault_dir, limit.min(1000), client_id.as_deref())
        .map_err(|e| format!("Could not read the access log: {e}"))
}

/// Open a pairing window so the browser extension can collect a token.
///
/// Called from a deliberate user action — the setup wizard's Connect button, or
/// the same button in Settings. The window closes on its own after two minutes,
/// or as soon as one client pairs.
///
/// `scope` is "secrets" for the browser extension, which has to decrypt in order
/// to fill a password, or "notes" for a client that only needs to read pages.
#[tauri::command]
pub fn begin_extension_pairing(
    scope: String,
    state: State<VaultState>,
    pairing: State<crate::local_api::pairing::PairingState>,
) -> Result<(), String> {
    // Refuse to open a window with nothing behind it: without a vault there is
    // no token to hand over, and the extension would pair into an error.
    state.vault_dir().ok_or("Vault not open")?;

    let scope = match scope.as_str() {
        "notes" => TokenScope::Notes,
        "secrets" => TokenScope::Secrets,
        other => {
            return Err(format!(
                "unknown scope '{other}' — expected notes or secrets"
            ))
        }
    };
    pairing.arm(scope);
    Ok(())
}

/// Close the pairing window without pairing — the user navigated away or
/// cancelled.
#[tauri::command]
pub fn cancel_extension_pairing(pairing: State<crate::local_api::pairing::PairingState>) {
    pairing.disarm();
}

/// Whether a pairing window is open, and for how much longer.
///
/// The setup wizard polls this so it can show a countdown and notice the moment
/// pairing completes: the window closing is what tells it the extension took the
/// token.
#[tauri::command]
pub fn extension_pairing_status(
    pairing: State<crate::local_api::pairing::PairingState>,
) -> serde_json::Value {
    let status = pairing.status();
    serde_json::json!({
        "armed": status.armed,
        "secondsLeft": status.seconds_left,
    })
}

/// Resolve a pending secret-access approval request raised by an API client.
///
/// When an API client requests a secret, the backend blocks and shows the user a
/// prompt; this command delivers the user's decision. `approved` allows or denies
/// the request; `remember` is "once", "session" (every client until lock, the
/// vault-wide grant of ADR 0001) or "always" (this client, this page, until
/// revoked in Settings, ADR 0003). Unknown `request_id`s are silently ignored.
#[tauri::command]
pub fn approve_secret_access(
    request_id: String,
    approved: bool,
    remember: String,
    state: State<ApprovalManager>,
    vault: State<VaultState>,
) -> Result<(), String> {
    let remember = crate::local_api::approval::Remember::parse(&remember)
        .ok_or_else(|| format!("unknown remember value '{remember}'"))?;
    if let Some(info) = state.resolve(&request_id, approved, remember) {
        let vault_dir = vault.vault_dir().ok_or("Vault not open")?;
        crate::internal::approval_grants::add(
            &vault_dir,
            crate::internal::approval_grants::Grant {
                client_id: info.client_id,
                client_name: info.client_name,
                target: info.target,
                granted_at: chrono::Utc::now(),
            },
        )
        .map_err(|e| format!("Could not save the standing approval: {e}"))?;
    }
    Ok(())
}

/// Every standing approval, for the Settings list.
#[tauri::command]
pub fn list_approval_grants(
    state: State<VaultState>,
) -> Result<Vec<crate::internal::approval_grants::Grant>, String> {
    let vault_dir = state.vault_dir().ok_or("Vault not open")?;
    Ok(crate::internal::approval_grants::list(&vault_dir))
}

/// Every memory namespace and page with its review, staleness and read
/// statistics, for the Agent Memory dashboard.
#[tauri::command]
pub fn memory_overview(
    state: State<VaultState>,
) -> Result<Vec<crate::pages::agent_memory::NamespaceOverview>, String> {
    let vault_dir = state.vault_dir().ok_or("Vault not open")?;
    crate::pages::agent_memory::overview(&vault_dir).map_err(|e| e.to_string())
}

/// Withdraw one standing approval. The next request prompts again.
#[tauri::command]
pub fn revoke_approval_grant(
    client_id: String,
    target: String,
    state: State<VaultState>,
) -> Result<bool, String> {
    let vault_dir = state.vault_dir().ok_or("Vault not open")?;
    crate::internal::approval_grants::revoke(&vault_dir, &client_id, &target)
        .map_err(|e| format!("Could not revoke the standing approval: {e}"))
}

/// Get current API server status as JSON: `{ "running": bool, "port": number }`.
#[tauri::command]
pub fn local_api_status(api_state: State<LocalApiState>) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "running": api_state.is_running(),
        "port": api_state.get_port(),
    }))
}

/// Return the absolute path of the running Claspt binary.
///
/// Used by the frontend to help users configure an MCP server that shells out to
/// this executable. Errors if the path cannot be detected or is not valid UTF-8.
/// Prepare an AI tool's connection in one call: mint it a client of its own,
/// switch the local API on, and return the config to paste.
///
/// One call rather than three because the walkthrough has to leave the user
/// with something that works. Its snippet used to carry no token at all, so
/// the tool started and every request was refused; sending people to Settings
/// to finish is the thing the walkthrough exists to avoid.
///
/// The token is a named, revocable client rather than the vault-wide token, so
/// it can be withdrawn from one tool without affecting anything else. `scope`
/// is "notes" (secret values redacted, secret writes refused) or "secrets".
#[tauri::command]
pub async fn connect_ai_tool(
    app: AppHandle,
    scope: String,
    vault_state: State<'_, VaultState>,
    api_state: State<'_, LocalApiState>,
) -> Result<serde_json::Value, String> {
    let vault_dir = vault_state.vault_dir().ok_or("Vault not open")?;
    let token_scope = match scope.as_str() {
        "notes" => TokenScope::Notes,
        "secrets" => TokenScope::Secrets,
        other => {
            return Err(format!(
                "unknown scope '{other}' — expected notes or secrets"
            ))
        }
    };

    let minted = clients::create(&vault_dir, "AI tool", token_scope, &[])
        .map_err(|e| format!("Could not create API client: {e}"))?;

    // Remember that the API is on, so it comes back up on the next unlock
    // rather than only for this session.
    let mut config =
        init::read_config(&vault_dir).map_err(|e| format!("Config read failed: {e}"))?;
    if config.local_api_enabled != Some(true) {
        config.local_api_enabled = Some(true);
        init::write_config(&vault_dir, &config)
            .map_err(|e| format!("Could not save config: {e}"))?;
    }
    let port = config.local_api_port;

    if !api_state.is_running() {
        let handle = app.clone();
        tokio::spawn(async move {
            if let Err(e) = server::start_server(port, handle).await {
                log::error!("Local API server failed: {e}");
            }
        });
    }

    let exe =
        std::env::current_exe().map_err(|e| format!("Failed to detect executable path: {e}"))?;
    let snippet = crate::mcp_install::snippet(&exe, minted.token.as_str())?;

    Ok(serde_json::json!({
        "snippet": snippet,
        "port": port,
        "scope": scope,
    }))
}

#[tauri::command]
pub fn get_exe_path() -> Result<String, String> {
    std::env::current_exe()
        .map_err(|e| format!("Failed to detect executable path: {e}"))?
        .to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "Executable path contains invalid UTF-8".to_string())
}
