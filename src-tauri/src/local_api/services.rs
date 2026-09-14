// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! What the local API needs from its host, behind one trait, so the same
//! routes serve the desktop app (state managed by Tauri, prompts in the
//! UI) and `claspt serve` (state owned by the process, decisions from a
//! policy file, no UI at all).

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use super::approval::{ApprovalManager, ApprovalRequest};
use super::browser_jobs::BrowserJobs;
use super::clients::ClientToken;
use super::pairing::PairingState;
use super::policy::Policy;
use super::rate_limit::SecretReadLimiter;
use crate::commands::crypto::VaultState;
use crate::commands::git::GitState;
use crate::commands::search::SearchState;
use crate::ssh_agent::SshAgentState;

/// What the host says about one request, before any prompt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Authorization {
    /// Proceed; no prompt.
    Allow,
    /// Refuse with this reason.
    Deny(String),
    /// Apply the approval rules (mode, standing grants, prompt).
    Ask,
}

pub type SpawnedFuture = Pin<Box<dyn Future<Output = ()> + Send + 'static>>;

pub trait Services: Send + Sync + 'static {
    fn vault(&self) -> &VaultState;
    fn search(&self) -> &SearchState;
    fn git(&self) -> &GitState;
    fn approval(&self) -> &ApprovalManager;
    fn limiter(&self) -> &SecretReadLimiter;
    fn browser_jobs(&self) -> &BrowserJobs;
    fn ssh_agent(&self) -> &SshAgentState;
    fn pairing(&self) -> &PairingState;
    /// "desktop" or "headless", reported by `/api/status`.
    fn mode(&self) -> &'static str;
    /// Tell the UI, if there is one, that pages changed.
    fn pages_changed(&self);
    /// The host's own say on a request. The desktop has none beyond the
    /// approval rules; a headless server has a policy file.
    fn authorize(&self, client: &ClientToken, action: &str, target: &str) -> Authorization;
    /// Show the approval prompt. Returns false when nobody can be asked, in
    /// which case the request is refused.
    fn prompt(&self, request: ApprovalRequest) -> bool;
    fn spawn(&self, fut: SpawnedFuture);
}

/// The desktop app: everything lives in Tauri's managed state and the
/// prompt is a window.
pub struct TauriServices {
    app: tauri::AppHandle,
}

impl TauriServices {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }
}

impl Services for TauriServices {
    fn vault(&self) -> &VaultState {
        use tauri::Manager;
        self.app.state::<VaultState>().inner()
    }
    fn search(&self) -> &SearchState {
        use tauri::Manager;
        self.app.state::<SearchState>().inner()
    }
    fn git(&self) -> &GitState {
        use tauri::Manager;
        self.app.state::<GitState>().inner()
    }
    fn approval(&self) -> &ApprovalManager {
        use tauri::Manager;
        self.app.state::<ApprovalManager>().inner()
    }
    fn limiter(&self) -> &SecretReadLimiter {
        use tauri::Manager;
        self.app.state::<SecretReadLimiter>().inner()
    }
    fn browser_jobs(&self) -> &BrowserJobs {
        use tauri::Manager;
        self.app.state::<BrowserJobs>().inner()
    }
    fn ssh_agent(&self) -> &SshAgentState {
        use tauri::Manager;
        self.app.state::<SshAgentState>().inner()
    }
    fn pairing(&self) -> &PairingState {
        use tauri::Manager;
        self.app.state::<PairingState>().inner()
    }
    fn mode(&self) -> &'static str {
        "desktop"
    }
    fn pages_changed(&self) {
        use tauri::Emitter;
        let _ = self.app.emit("pages-changed", ());
    }
    fn authorize(&self, _client: &ClientToken, _action: &str, _target: &str) -> Authorization {
        Authorization::Ask
    }
    fn prompt(&self, request: ApprovalRequest) -> bool {
        use tauri::Emitter;
        self.app.emit("secret-access-request", request).is_ok()
    }
    fn spawn(&self, fut: SpawnedFuture) {
        tauri::async_runtime::spawn(fut);
    }
}

/// `claspt serve`: state owned by the process, every request decided by the
/// policy file, no prompt possible.
pub struct HeadlessServices {
    pub vault: VaultState,
    pub search: SearchState,
    pub git: GitState,
    pub approval: ApprovalManager,
    pub limiter: SecretReadLimiter,
    pub browser_jobs: BrowserJobs,
    pub ssh_agent: SshAgentState,
    pub pairing: PairingState,
    pub policy: Policy,
    pub runtime: tokio::runtime::Handle,
}

impl HeadlessServices {
    pub fn new(vault: VaultState, policy: Policy, runtime: tokio::runtime::Handle) -> Self {
        Self {
            vault,
            search: SearchState::new(),
            git: GitState::new(),
            approval: ApprovalManager::new(),
            limiter: SecretReadLimiter::new(),
            browser_jobs: BrowserJobs::new(),
            ssh_agent: SshAgentState::new(),
            pairing: PairingState::new(),
            policy,
            runtime,
        }
    }
}

impl Services for HeadlessServices {
    fn vault(&self) -> &VaultState {
        &self.vault
    }
    fn search(&self) -> &SearchState {
        &self.search
    }
    fn git(&self) -> &GitState {
        &self.git
    }
    fn approval(&self) -> &ApprovalManager {
        &self.approval
    }
    fn limiter(&self) -> &SecretReadLimiter {
        &self.limiter
    }
    fn browser_jobs(&self) -> &BrowserJobs {
        &self.browser_jobs
    }
    fn ssh_agent(&self) -> &SshAgentState {
        &self.ssh_agent
    }
    fn pairing(&self) -> &PairingState {
        &self.pairing
    }
    fn mode(&self) -> &'static str {
        "headless"
    }
    fn pages_changed(&self) {}
    fn authorize(&self, client: &ClientToken, action: &str, target: &str) -> Authorization {
        if self.policy.allows(client, action, target) {
            Authorization::Allow
        } else {
            Authorization::Deny(format!(
                "policy does not allow {action} on {target} for client '{}'",
                client.name
            ))
        }
    }
    fn prompt(&self, _request: ApprovalRequest) -> bool {
        false
    }
    fn spawn(&self, fut: SpawnedFuture) {
        self.runtime.spawn(fut);
    }
}

/// Convenience for callers holding an app handle.
pub fn tauri_services(app: tauri::AppHandle) -> Arc<dyn Services> {
    Arc::new(TauriServices::new(app))
}
