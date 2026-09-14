// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Secret access approval manager.
//!
//! When `secret_access_mode == "approve"`, API requests using a Secrets-scope
//! token must be approved by the user via a UI dialog before the request
//! proceeds. The manager holds pending approval requests as `oneshot` channels
//! together with who asked and for what, so a decision of "always" can be
//! turned into a standing grant for exactly that client and that page
//! (`internal::approval_grants`, ADR 0003).

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

/// Manages pending secret access approval requests.
pub struct ApprovalManager {
    /// Pending approval requests: request_id → (sender, who and what).
    pending: Mutex<HashMap<String, (oneshot::Sender<bool>, PendingInfo)>>,
    /// Whether the user has granted blanket session approval.
    session_approved: Mutex<bool>,
}

/// What a pending request was about, kept so a decision can be persisted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingInfo {
    pub client_id: String,
    pub client_name: String,
    pub target: String,
}

/// How far a decision reaches.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Remember {
    /// This request only.
    Once,
    /// Every secrets-scope request from any client until the vault locks
    /// (the vault-wide grant of ADR 0001, kept for users who want it).
    Session,
    /// This client, this target, until revoked in Settings.
    Always,
}

impl Remember {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "once" => Some(Self::Once),
            "session" => Some(Self::Session),
            "always" => Some(Self::Always),
            _ => None,
        }
    }
}

/// Information about a pending approval request, emitted as a Tauri event.
#[derive(Debug, Clone, Serialize)]
pub struct ApprovalRequest {
    /// Correlation id the UI echoes back to [`ApprovalManager::resolve`].
    pub request_id: String,
    /// Human-readable name of what is being accessed (the request path).
    pub tool_name: String,
    /// The vault page/path involved, when known.
    pub page_path: Option<String>,
    /// Which client is asking, so the prompt names it rather than saying
    /// "an agent", and so a grant can be tied to it.
    pub client_id: String,
    pub client_name: String,
    /// What an "always" decision would cover: the page for page and secret
    /// reads, otherwise the request path.
    pub target: String,
    /// Secret reads this client made in the last minute, so a burst is
    /// visible at the moment of deciding.
    pub recent_secret_reads: u32,
}

/// The prompt: emit the request to the UI and wait for the owner's answer.
/// Returns true only on an explicit approval within the window; a standing
/// grant for this client and target, or a session-wide approval, answers
/// without prompting (ADR 0003). Shared by the HTTP auth layer and the SSH
/// agent so both put a secret use through exactly the same gate.
#[allow(clippy::too_many_arguments)]
pub async fn gate(
    services: &dyn super::services::Services,
    vault_dir: &std::path::Path,
    client_id: &str,
    client_name: &str,
    target: &str,
    tool_name: &str,
    recent_secret_reads: u32,
) -> bool {
    let approval = services.approval();
    if approval.is_session_approved()
        || crate::internal::approval_grants::is_granted(vault_dir, client_id, target)
    {
        return true;
    }
    let request_id = uuid::Uuid::new_v4().to_string();
    let shown = services.prompt(ApprovalRequest {
        request_id: request_id.clone(),
        tool_name: tool_name.to_string(),
        page_path: Some(target.to_string()),
        client_id: client_id.to_string(),
        client_name: client_name.to_string(),
        target: target.to_string(),
        recent_secret_reads,
    });
    if !shown {
        // Nobody to ask: a refusal, never a silent allow.
        return false;
    }
    let rx = approval.request(
        request_id,
        PendingInfo {
            client_id: client_id.to_string(),
            client_name: client_name.to_string(),
            target: target.to_string(),
        },
    );
    // The owner gets 30 s; a prompt nobody answers is a refusal.
    matches!(
        tokio::time::timeout(std::time::Duration::from_secs(30), rx).await,
        Ok(Ok(true))
    )
}

/// What a standing grant for a request covers.
///
/// A page and its secret route are the same thing to the user ("this page"),
/// so both map to the page path; everything else is granted by its exact
/// path. The input is the raw request path; the output is URL-decoded.
pub fn grant_target_for(path: &str) -> String {
    let decoded = urlencoding::decode(path)
        .map(|p| p.into_owned())
        .unwrap_or_else(|_| path.to_string());
    // A login request is approved for the page it will use, like a read of it.
    if let Some(page) = decoded.strip_prefix("/api/browser/login/") {
        return page.to_string();
    }
    // A passkey request is approved for its relying party.
    if let Some(rest) = decoded.strip_prefix("/api/passkeys/") {
        if let Some(rp) = rest.split('/').next().filter(|r| !r.is_empty()) {
            return format!("passkeys/{rp}");
        }
    }
    if let Some(rest) = decoded.strip_prefix("/api/pages/") {
        let page = rest
            .strip_suffix("/secret")
            .or_else(|| rest.strip_suffix("/secret/rename"))
            .unwrap_or(rest);
        return page.to_string();
    }
    decoded
}

impl Default for ApprovalManager {
    fn default() -> Self {
        Self::new()
    }
}

impl ApprovalManager {
    /// Create an empty manager: no pending requests and no session approval.
    pub fn new() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
            session_approved: Mutex::new(false),
        }
    }

    /// Check if the session has blanket approval.
    pub fn is_session_approved(&self) -> bool {
        self.session_approved
            .lock()
            .ok()
            .map(|g| *g)
            .unwrap_or(false)
    }

    /// Register a pending approval request, returning a receiver to await the decision.
    pub fn request(&self, request_id: String, info: PendingInfo) -> oneshot::Receiver<bool> {
        let (tx, rx) = oneshot::channel();
        if let Ok(mut guard) = self.pending.lock() {
            guard.insert(request_id, (tx, info));
        }
        rx
    }

    /// Resolve a pending approval request.
    ///
    /// Returns what the request was about when `approved` and `remember` is
    /// `Always`, so the caller can persist the grant; the manager itself keeps
    /// nothing durable. `Session` sets the vault-wide session flag.
    pub fn resolve(
        &self,
        request_id: &str,
        approved: bool,
        remember: Remember,
    ) -> Option<PendingInfo> {
        if approved && remember == Remember::Session {
            if let Ok(mut guard) = self.session_approved.lock() {
                *guard = true;
            }
        }
        let info = self
            .pending
            .lock()
            .ok()
            .and_then(|mut guard| guard.remove(request_id))
            .map(|(tx, info)| {
                let _ = tx.send(approved);
                info
            });
        match (approved, remember) {
            (true, Remember::Always) => info,
            _ => None,
        }
    }

    /// Clear session approval and all pending requests (called on vault lock).
    pub fn clear_session(&self) {
        if let Ok(mut guard) = self.session_approved.lock() {
            *guard = false;
        }
        if let Ok(mut pending) = self.pending.lock() {
            for (_, (tx, _)) in pending.drain() {
                let _ = tx.send(false);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_page_and_its_secret_route_share_one_grant_target() {
        assert_eq!(
            grant_target_for("/api/pages/credentials%2Faws.md"),
            "credentials/aws.md"
        );
        assert_eq!(
            grant_target_for("/api/pages/credentials%2Faws.md/secret"),
            "credentials/aws.md"
        );
        assert_eq!(
            grant_target_for("/api/pages/credentials%2Faws.md/secret/rename"),
            "credentials/aws.md"
        );
        assert_eq!(
            grant_target_for("/api/memory/claspt/decisions"),
            "/api/memory/claspt/decisions"
        );
        assert_eq!(grant_target_for("/api/secrets"), "/api/secrets");
    }

    fn info() -> PendingInfo {
        PendingInfo {
            client_id: "c1".into(),
            client_name: "Claude Code".into(),
            target: "credentials/aws.md".into(),
        }
    }

    #[tokio::test]
    async fn resolve_returns_the_request_only_for_an_approved_always() {
        let m = ApprovalManager::new();
        let rx = m.request("r1".into(), info());
        assert_eq!(m.resolve("r1", true, Remember::Always), Some(info()));
        assert!(rx.await.unwrap());

        let rx = m.request("r2".into(), info());
        assert_eq!(m.resolve("r2", true, Remember::Once), None);
        assert!(rx.await.unwrap());

        let rx = m.request("r3".into(), info());
        assert_eq!(
            m.resolve("r3", false, Remember::Always),
            None,
            "a denial never grants"
        );
        assert!(!rx.await.unwrap());

        assert!(!m.is_session_approved());
        let rx = m.request("r4".into(), info());
        m.resolve("r4", true, Remember::Session);
        assert!(rx.await.unwrap());
        assert!(m.is_session_approved());
        m.clear_session();
        assert!(!m.is_session_approved());
    }

    #[tokio::test]
    async fn clearing_the_session_denies_everything_pending() {
        let m = ApprovalManager::new();
        let rx = m.request("r".into(), info());
        m.clear_session();
        assert!(!rx.await.unwrap());
        assert_eq!(m.resolve("r", true, Remember::Always), None, "already gone");
    }

    #[test]
    fn remember_parses_exactly_three_words() {
        assert_eq!(Remember::parse("once"), Some(Remember::Once));
        assert_eq!(Remember::parse("session"), Some(Remember::Session));
        assert_eq!(Remember::parse("always"), Some(Remember::Always));
        assert_eq!(Remember::parse("forever"), None);
    }
}
