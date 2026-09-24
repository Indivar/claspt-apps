// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Token scopes and bearer-token authentication/authorization for the local API.
//!
//! Every request to `/api/...` must carry an `Authorization: Bearer <token>`
//! header. The token's prefix encodes its **scope**, which determines what the
//! request may touch:
//!
//! - **Notes** (`clsn_`): pages, search, folders, and non-secret content. Secret
//!   values are redacted rather than decrypted, and secret-mutating routes are
//!   refused.
//! - **Secrets** (`clss_`, plus legacy `clsp_`): everything a Notes token can do,
//!   plus reading decrypted secret values and creating/modifying secret blocks.
//!
//! [`require_auth`] is the axum middleware applied to every route. It extracts and
//! validates the token (in constant time, via [`constant_time_eq`]), determines the
//! scope, optionally runs the secret-approval flow for Secrets-scope requests (see
//! [`super::approval`]), and injects an [`AuthInfo`] into the request extensions so
//! handlers can read the caller's scope and identity. Tokens belong to named
//! clients and are stored as hashes; see [`super::clients`].

use axum::{
    extract::Request,
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
};
use ring::rand::SecureRandom;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use super::server::ApiContext;

// ── Token scopes ───────────────────────────────────────

/// Access scope encoded in the token prefix.
///
/// | Prefix | Scope   | Access                                    |
/// |--------|---------|-------------------------------------------|
/// | clsn_  | Notes   | Pages, search, folders. Secrets redacted.  |
/// | clss_  | Secrets | Full access including secret decryption.   |
/// | clsp_  | Legacy  | Treated as Secrets (backward compat).      |
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TokenScope {
    /// Read/write of non-secret note content. Secret values are redacted;
    /// secret-mutating routes are refused.
    Notes,
    /// Full access, including decryption of secret values and secret block
    /// mutation. Subject to the secret-approval flow when enabled.
    Secrets,
}

impl TokenScope {
    /// Detect scope from the token prefix.
    pub fn from_token(token: &str) -> Option<Self> {
        if token.starts_with("clsn_") {
            Some(Self::Notes)
        } else if token.starts_with("clss_") || token.starts_with("clsp_") {
            Some(Self::Secrets)
        } else {
            None
        }
    }

    /// Token prefix for this scope.
    pub fn prefix(&self) -> &'static str {
        match self {
            Self::Notes => "clsn_",
            Self::Secrets => "clss_",
        }
    }
}

/// Authentication info inserted into request extensions after token validation.
///
/// Can be extracted in route handlers via `Extension(auth): Extension<AuthInfo>`.
#[derive(Debug, Clone)]
pub struct AuthInfo {
    pub scope: TokenScope,
    /// The registry id of the client whose token authenticated this request.
    pub client_id: String,
    /// Its display name, for logs and approval prompts.
    pub client_name: String,
    /// Memory namespaces the client may touch; empty means all.
    pub namespaces: Vec<String>,
    /// The client's kind from the registry ("extension" for paired browser
    /// extensions); None for everything else.
    pub client_kind: Option<String>,
}

impl AuthInfo {
    /// Whether this request comes from a paired browser extension.
    pub fn is_extension(&self) -> bool {
        self.client_kind.as_deref() == Some("extension")
    }

    /// An identity for tests and internal callers that have no client.
    #[cfg(test)]
    pub fn test(scope: TokenScope) -> Self {
        Self {
            scope,
            client_id: "test-client".to_string(),
            client_name: "test".to_string(),
            namespaces: Vec::new(),
            client_kind: None,
        }
    }

    /// Whether this client may read or write memory in `namespace`.
    pub fn may_use_namespace(&self, namespace: &str) -> bool {
        self.namespaces.is_empty() || self.namespaces.iter().any(|n| n == namespace)
    }
}

/// Axum extractor for AuthInfo from request extensions.
impl<S: Send + Sync> axum::extract::FromRequestParts<S> for AuthInfo {
    type Rejection = (StatusCode, &'static str);

    async fn from_request_parts(
        parts: &mut axum::http::request::Parts,
        _state: &S,
    ) -> Result<Self, Self::Rejection> {
        parts
            .extensions
            .get::<AuthInfo>()
            .cloned()
            .ok_or((StatusCode::INTERNAL_SERVER_ERROR, "Auth info missing"))
    }
}

// ── Token generation ──────────────────────────────────

/// Whether a request will hand decrypted secret values to the client, which
/// is what the per-minute limit counts. `secret.read` always does; a page or
/// memory read does only under Secrets scope, since Notes scope gets
/// redacted bodies.
fn decrypts(action: &str, scope: TokenScope) -> bool {
    // The mutating secret routes and memory append hand back the page with
    // every block decrypted, so they read as much as a read does. Left off
    // this list they escaped the decrypt limiter and showed in the log as
    // writes, and a client with a standing grant could read any page
    // without limit by patching and unpatching a field.
    scope == TokenScope::Secrets
        && matches!(
            action,
            "secret.read"
                | "page.read"
                | "memory.read"
                | "browser.login"
                | "passkey.register"
                | "passkey.authenticate"
                | "secret.write"
                | "secret.delete"
                | "secret.rename"
                | "memory.write"
                | "memory.append"
        )
}

/// Whether this request must be approved in the app first.
///
/// Approve mode used to prompt for every request from a secrets token,
/// /api/status and folder listings included. The first prompt Claude Code
/// produced was for /api/status, the user answered "remember for session",
/// and every later secret read was silent: the safeguard undid itself. Only
/// a request that hands out decrypted content is worth a prompt.
fn approval_needed(action: &str, scope: TokenScope, mode: Option<&str>) -> bool {
    mode == Some("approve") && decrypts(action, scope)
}

/// Constant-time byte comparison (prevents timing attacks). One
/// implementation for the whole workspace lives in the core crate.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    claspt_core::crypto::compare::constant_time_eq(a, b)
}

/// Generate a scoped API token with the appropriate prefix.
pub fn generate_scoped_token(scope: TokenScope) -> String {
    let mut buf = [0u8; 32];
    ring::rand::SystemRandom::new()
        .fill(&mut buf)
        .expect("CSPRNG fill failed");
    format!("{}{}", scope.prefix(), hex_encode(&buf))
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ── Auth middleware ───────────────────────────────────

/// Axum middleware that checks the Bearer token on every request.
///
/// Validates against all configured tokens (notes, secrets, legacy),
/// determines scope from prefix, and injects `AuthInfo` into request extensions.
pub async fn require_auth(request: Request, next: Next) -> Response {
    let started = std::time::Instant::now();
    let method = request.method().as_str().to_string();
    // Path only: the query string can carry search terms and labels, which do
    // not belong in a log that outlives the request.
    let target = urlencoding::decode(request.uri().path())
        .map(|p| p.into_owned())
        .unwrap_or_else(|_| request.uri().path().to_string());
    let action = crate::internal::access_log::action_for(&method, request.uri().path());

    let vault_dir = request
        .extensions()
        .get::<Arc<ApiContext>>()
        .and_then(|ctx| ctx.services.vault().vault_dir());

    let (response, identity) = authenticate_and_run(request, next).await;

    // Every request is recorded, including the ones that never authenticated:
    // a run of 401s is the shape a token-guessing attempt has.
    if let Some(vault_dir) = vault_dir {
        let (client_id, client_name, scope) = match identity {
            Some(auth) => (auth.client_id, auth.client_name, Some(auth.scope)),
            None => (String::new(), "(unauthenticated)".to_string(), None),
        };
        let entry = crate::internal::access_log::AccessEntry {
            ts: chrono::Utc::now(),
            client_id,
            client_name,
            scope,
            action: action.to_string(),
            method,
            target,
            status: response.status().as_u16(),
            duration_ms: started.elapsed().as_millis() as u64,
        };
        if let Err(e) = crate::internal::access_log::record(&vault_dir, &entry) {
            log::warn!("[api] access log write failed: {e}");
        }
    }
    response
}

/// The authentication half of [`require_auth`]: returns the response and, when
/// a client authenticated, who it was, so the caller can log both.
async fn authenticate_and_run(mut request: Request, next: Next) -> (Response, Option<AuthInfo>) {
    let ctx = match request.extensions().get::<Arc<ApiContext>>() {
        Some(ctx) => ctx.clone(),
        None => {
            return (
                (StatusCode::INTERNAL_SERVER_ERROR, "Server misconfigured").into_response(),
                None,
            )
        }
    };

    // Check Authorization header
    let auth_header = request
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok());

    let token = match auth_header {
        Some(h) if h.starts_with("Bearer ") => &h[7..],
        _ => {
            return (
                (
                    StatusCode::UNAUTHORIZED,
                    "Missing or invalid Authorization header",
                )
                    .into_response(),
                None,
            )
        }
    };

    // Two-tier lock model:
    // - UI lock: master key still in memory, API fully operational.
    // - Key lock: master key zeroed, vault_dir still set. Routes that
    //   need decryption will fail gracefully (403 from route helpers).
    // The auth middleware does not block on lock state — individual route
    // helpers (vault_dir(), master_key()) handle it.
    let vault = ctx.services.vault();

    // Read the vault config once for the approval mode, and the client
    // registry for the token. Neither is cached: a token minted by the CLI or
    // revoked in Settings must take effect on the very next request, and
    // nothing may fall back to something more permissive when a file cannot
    // be read.
    let Some(vault_dir) = vault.vault_dir() else {
        return (
            (StatusCode::UNAUTHORIZED, "Vault configuration unavailable").into_response(),
            None,
        );
    };
    let config = match crate::vault::init::read_config(&vault_dir) {
        Ok(config) => config,
        Err(_) => {
            return (
                (StatusCode::UNAUTHORIZED, "Vault configuration unavailable").into_response(),
                None,
            )
        }
    };
    let registry = match super::clients::load(&vault_dir) {
        Ok(registry) => registry,
        Err(_) => {
            return (
                (StatusCode::UNAUTHORIZED, "Client registry unavailable").into_response(),
                None,
            )
        }
    };
    let client = match registry.find(token) {
        Some(client) => client.clone(),
        None => {
            return (
                (StatusCode::UNAUTHORIZED, "Invalid token").into_response(),
                None,
            )
        }
    };
    let scope = client.scope;

    // Secret-scope requests may require explicit user approval. See
    // `docs/adr/0001-global-secret-access-approval.md` for why this grant is
    // vault-wide and session-wide rather than scoped per token or per secret.
    let path = request.uri().path().to_string();
    let action = crate::internal::access_log::action_for(request.method().as_str(), &path);
    let target = super::approval::grant_target_for(&path);
    // The host's own say comes first: a headless server decides every
    // request from its policy file and never prompts; the desktop leaves it
    // to the approval rules below.
    let policy_target = super::policy::policy_target(&target);
    let ask = match ctx.services.authorize(&client, action, &policy_target) {
        super::services::Authorization::Allow => false,
        super::services::Authorization::Ask => true,
        super::services::Authorization::Deny(reason) => {
            return (
                (StatusCode::FORBIDDEN, reason).into_response(),
                Some(AuthInfo {
                    scope,
                    client_id: client.id.clone(),
                    client_name: client.name.clone(),
                    namespaces: client.namespaces.clone(),
                    client_kind: client.kind.clone(),
                }),
            );
        }
    };

    let limiter = ctx.services.limiter();

    // A brake on a client decrypting in a loop: past the vault's per-minute
    // limit it is told to wait. Counted before approval so a prompt is never
    // raised for a request that would be refused anyway.
    if decrypts(action, scope) {
        if let Err(wait) = limiter.record(
            &client.id,
            config.secret_read_rate_limit_per_minute,
            std::time::Instant::now(),
        ) {
            let mut response = (
                StatusCode::TOO_MANY_REQUESTS,
                format!(
                    "Secret read limit reached ({} per minute); retry in {} s",
                    config.secret_read_rate_limit_per_minute, wait.seconds
                ),
            )
                .into_response();
            response
                .headers_mut()
                .insert("retry-after", axum::http::HeaderValue::from(wait.seconds));
            return (
                response,
                Some(AuthInfo {
                    scope,
                    client_id: client.id.clone(),
                    client_name: client.name.clone(),
                    namespaces: client.namespaces.clone(),
                    client_kind: client.kind.clone(),
                }),
            );
        }
    }

    if ask && approval_needed(action, scope, config.secret_access_mode.as_deref()) {
        let allowed = super::approval::gate(
            ctx.services.as_ref(),
            &vault_dir,
            &client.id,
            &client.name,
            &target,
            &path,
            limiter.recent(&client.id, std::time::Instant::now()),
        )
        .await;
        if !allowed {
            return (
                (StatusCode::FORBIDDEN, "Secret access denied or timed out").into_response(),
                Some(AuthInfo {
                    scope,
                    client_id: client.id.clone(),
                    client_name: client.name.clone(),
                    namespaces: client.namespaces.clone(),
                    client_kind: client.kind.clone(),
                }),
            );
        }
    }

    let auth = AuthInfo {
        scope,
        client_id: client.id,
        client_name: client.name,
        namespaces: client.namespaces,
        client_kind: client.kind,
    };
    request.extensions_mut().insert(auth.clone());
    // A request from an authorised client counts as activity for the key
    // lock, so a browser extension or an AI tool at work behind a locked
    // screen is not cut off mid-task. The screen lock is left alone.
    vault.touch_api_activity();
    (next.run(request).await, Some(auth))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_scope_from_prefix() {
        assert_eq!(
            TokenScope::from_token("clsn_abc123"),
            Some(TokenScope::Notes)
        );
        assert_eq!(
            TokenScope::from_token("clss_abc123"),
            Some(TokenScope::Secrets)
        );
        assert_eq!(
            TokenScope::from_token("clsp_abc123"),
            Some(TokenScope::Secrets)
        );
        assert_eq!(TokenScope::from_token("invalid_abc"), None);
        assert_eq!(TokenScope::from_token(""), None);
    }

    #[test]
    fn scoped_token_prefix() {
        assert_eq!(TokenScope::Notes.prefix(), "clsn_");
        assert_eq!(TokenScope::Secrets.prefix(), "clss_");
    }

    #[test]
    fn generate_scoped_token_format() {
        let notes_token = generate_scoped_token(TokenScope::Notes);
        assert!(notes_token.starts_with("clsn_"));
        assert_eq!(notes_token.len(), 5 + 64); // prefix + 32 hex bytes

        let secrets_token = generate_scoped_token(TokenScope::Secrets);
        assert!(secrets_token.starts_with("clss_"));
        assert_eq!(secrets_token.len(), 5 + 64);
    }

    #[test]
    fn constant_time_eq_works() {
        assert!(constant_time_eq(b"hello", b"hello"));
        assert!(!constant_time_eq(b"hello", b"world"));
        assert!(!constant_time_eq(b"hello", b"hell"));
    }

    #[test]
    fn only_decrypting_reads_count_toward_the_limit() {
        assert!(decrypts("secret.read", TokenScope::Secrets));
        assert!(decrypts("page.read", TokenScope::Secrets));
        assert!(decrypts("memory.read", TokenScope::Secrets));
        // Mutations that return the decrypted page count too.
        assert!(decrypts("secret.write", TokenScope::Secrets));
        assert!(decrypts("secret.delete", TokenScope::Secrets));
        assert!(decrypts("secret.rename", TokenScope::Secrets));
        assert!(decrypts("memory.append", TokenScope::Secrets));
        assert!(!decrypts("status", TokenScope::Secrets));
        assert!(!decrypts("page.list", TokenScope::Secrets));
        assert!(
            !decrypts("page.read", TokenScope::Notes),
            "notes scope gets redacted bodies"
        );
        assert!(!decrypts("secret.list", TokenScope::Secrets), "labels only");
        assert!(!decrypts("page.write", TokenScope::Secrets));
    }

    #[test]
    fn an_empty_namespace_list_means_every_namespace() {
        let mut open = AuthInfo::test(TokenScope::Notes);
        assert!(open.may_use_namespace("anything"));
        open.namespaces = vec!["claspt".into(), "global".into()];
        assert!(open.may_use_namespace("claspt"));
        assert!(open.may_use_namespace("global"));
        assert!(!open.may_use_namespace("other"));
    }
}

/// Refuse requests that did not come from this machine's own clients.
///
/// The server binds to 127.0.0.1, which keeps other machines out and nothing
/// else. A web page in the user's browser can still reach it: with DNS
/// rebinding the page is same-origin with the API and reads every response,
/// and even without that a plain cross-origin POST is delivered and consumes
/// the pairing window. Two headers the browser sets and the page cannot
/// override close both: `Host` must name loopback, and `Origin`, when a
/// browser sends one, must belong to the extension. Every route sits behind
/// this, including `/api/pair` and the 404 fallback.
pub async fn require_local_origin(request: Request, next: Next) -> Response {
    let host_ok = request
        .headers()
        .get(axum::http::header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
        .or_else(|| request.uri().authority().map(|a| a.to_string()))
        .is_some_and(|authority| host_is_loopback(&authority));
    let origin_ok = request
        .headers()
        .get(axum::http::header::ORIGIN)
        .map(|v| v.to_str().is_ok_and(origin_is_extension))
        .unwrap_or(true);
    if !host_ok || !origin_ok {
        return StatusCode::FORBIDDEN.into_response();
    }
    next.run(request).await
}

/// `authority` is `host[:port]`; only the loopback names are ours.
fn host_is_loopback(authority: &str) -> bool {
    let host = if let Some(rest) = authority.strip_prefix('[') {
        // Bracketed IPv6, "[::1]:9315".
        match rest.find(']') {
            Some(end) => &rest[..end],
            None => return false,
        }
    } else {
        authority.rsplit_once(':').map_or(authority, |(h, _)| h)
    };
    matches!(
        host.to_ascii_lowercase().as_str(),
        "127.0.0.1" | "localhost" | "::1"
    )
}

/// Extension origins are the only browser origins with any business here.
/// A page's `https://…` or an opaque `null` is refused.
fn origin_is_extension(origin: &str) -> bool {
    origin.starts_with("chrome-extension://")
        || origin.starts_with("moz-extension://")
        || origin.starts_with("safari-web-extension://")
}

#[cfg(test)]
mod local_origin_tests {
    use super::*;
    use axum::{body::Body, http::Request as HttpRequest, routing::get, Router};
    use tower::ServiceExt;

    fn app() -> Router {
        Router::new()
            .route("/x", get(|| async { "ok" }))
            .fallback(|| async { StatusCode::NOT_FOUND })
            .layer(axum::middleware::from_fn(require_local_origin))
    }

    async fn status(host: Option<&str>, origin: Option<&str>) -> StatusCode {
        let mut req = HttpRequest::builder().uri("/x");
        if let Some(h) = host {
            req = req.header("host", h);
        }
        if let Some(o) = origin {
            req = req.header("origin", o);
        }
        app()
            .oneshot(req.body(Body::empty()).unwrap())
            .await
            .unwrap()
            .status()
    }

    #[tokio::test]
    async fn loopback_hosts_pass() {
        for h in [
            "127.0.0.1:9315",
            "127.0.0.1",
            "localhost:9315",
            "LOCALHOST",
            "[::1]:9315",
        ] {
            assert_eq!(status(Some(h), None).await, StatusCode::OK, "{h}");
        }
    }

    #[tokio::test]
    async fn a_rebound_or_missing_host_is_refused() {
        // DNS rebinding: the page's own hostname now resolves to 127.0.0.1.
        assert_eq!(
            status(Some("evil.example:9315"), None).await,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            status(Some("127.0.0.1.evil.example"), None).await,
            StatusCode::FORBIDDEN
        );
        assert_eq!(status(None, None).await, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn only_extension_origins_pass() {
        assert_eq!(
            status(Some("127.0.0.1"), Some("chrome-extension://abc")).await,
            StatusCode::OK
        );
        assert_eq!(
            status(Some("127.0.0.1"), Some("moz-extension://abc")).await,
            StatusCode::OK
        );
        assert_eq!(
            status(Some("127.0.0.1"), Some("https://evil.example")).await,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            status(Some("127.0.0.1"), Some("null")).await,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            status(Some("127.0.0.1"), Some("http://127.0.0.1:9315")).await,
            StatusCode::FORBIDDEN
        );
    }

    #[tokio::test]
    async fn the_fallback_is_behind_the_gate_too() {
        let req = HttpRequest::builder()
            .uri("/nope")
            .header("host", "evil.example")
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            app().oneshot(req).await.unwrap().status(),
            StatusCode::FORBIDDEN
        );
    }
}

#[cfg(test)]
mod approval_needed_tests {
    use super::*;

    #[test]
    fn only_decrypting_requests_are_gated() {
        let approve = Some("approve");
        assert!(approval_needed("secret.read", TokenScope::Secrets, approve));
        assert!(approval_needed(
            "secret.write",
            TokenScope::Secrets,
            approve
        ));
        assert!(approval_needed("page.read", TokenScope::Secrets, approve));
        // What used to prompt, and must not: nothing here decrypts.
        assert!(!approval_needed("status", TokenScope::Secrets, approve));
        assert!(!approval_needed("page.list", TokenScope::Secrets, approve));
        assert!(!approval_needed(
            "folder.list",
            TokenScope::Secrets,
            approve
        ));
        assert!(!approval_needed("generate", TokenScope::Secrets, approve));
        // Notes scope never decrypts, and no mode but approve prompts.
        assert!(!approval_needed("secret.read", TokenScope::Notes, approve));
        assert!(!approval_needed("secret.read", TokenScope::Secrets, None));
        assert!(!approval_needed(
            "secret.read",
            TokenScope::Secrets,
            Some("log")
        ));
    }
}
