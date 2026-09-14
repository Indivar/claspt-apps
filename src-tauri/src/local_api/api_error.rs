// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Standardized JSON error envelope for the local HTTP API (v2.0.0).
//!
//! Every non-2xx response from `/api/...` returns:
//! ```json
//! { "error": { "code": "BLOCK_NOT_FOUND", "message": "...", "details": {...} } }
//! ```
//!
//! See `LOCAL-API.md` for the full code catalog. Routes use [`ApiError`] as
//! their error type via `IntoResponse`; the conversion writes the envelope.

use axum::{http::StatusCode, response::IntoResponse, Json};
use serde::Serialize;
use serde_json::Value;

/// Stable error code returned in the `error.code` field. Clients should
/// branch on this rather than parsing the message text.
///
/// This is a complete, stable taxonomy: some variants are part of the public
/// API contract but not yet produced by any route, so `dead_code` is allowed.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[allow(dead_code)]
pub enum ApiErrorCode {
    /// Malformed request body or parameters. → 400 Bad Request.
    BadRequest,
    /// Path or id could not be parsed/resolved. → 400 Bad Request.
    InvalidPath,
    /// Missing or invalid bearer token. → 401 Unauthorized.
    Unauthorized,
    /// Vault is locked (no `vault_dir`/master key available). → 403 Forbidden.
    VaultLocked,
    /// Token scope is too low for the operation (e.g. a Notes token touching
    /// secrets). → 403 Forbidden.
    ScopeInsufficient,
    /// Secret access was denied (or timed out) by the approval flow.
    /// → 403 Forbidden.
    ApprovalDenied,
    /// A pairing token was requested while no pairing window was open.
    /// → 403 Forbidden.
    PairingClosed,
    /// Requested page/resource does not exist. → 404 Not Found.
    NotFound,
    /// Named secret block was not found on the page. → 404 Not Found.
    BlockNotFound,
    /// A block with the target label already exists on the page.
    /// → 409 Conflict.
    LabelConflict,
    /// `If-Match` ETag did not match the current page. → 412 Precondition Failed.
    PreconditionFailed,
    /// Unexpected server-side failure. → 500 Internal Server Error.
    InternalError,
    /// A subsystem (e.g. search) is not yet initialized. → 503 Service Unavailable.
    NotReady,
}

impl ApiErrorCode {
    fn http_status(&self) -> StatusCode {
        match self {
            Self::BadRequest | Self::InvalidPath => StatusCode::BAD_REQUEST,
            Self::Unauthorized => StatusCode::UNAUTHORIZED,
            Self::VaultLocked
            | Self::ScopeInsufficient
            | Self::ApprovalDenied
            | Self::PairingClosed => StatusCode::FORBIDDEN,
            Self::NotFound | Self::BlockNotFound => StatusCode::NOT_FOUND,
            Self::LabelConflict => StatusCode::CONFLICT,
            Self::PreconditionFailed => StatusCode::PRECONDITION_FAILED,
            Self::NotReady => StatusCode::SERVICE_UNAVAILABLE,
            Self::InternalError => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

/// Error response that serializes to the standard envelope.
#[derive(Debug, Clone, Serialize)]
pub struct ApiError {
    #[serde(rename = "error")]
    inner: ErrorBody,
    #[serde(skip)]
    status: StatusCode,
}

#[derive(Debug, Clone, Serialize)]
struct ErrorBody {
    code: ApiErrorCode,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<Value>,
}

impl ApiError {
    /// Build an error from a code and message; the HTTP status is derived from
    /// the code (see the per-variant docs on [`ApiErrorCode`]).
    pub fn new(code: ApiErrorCode, message: impl Into<String>) -> Self {
        Self {
            status: code.http_status(),
            inner: ErrorBody {
                code,
                message: message.into(),
                details: None,
            },
        }
    }

    /// Attach a details object (passed through to `error.details`).
    pub fn with_details(mut self, details: Value) -> Self {
        self.inner.details = Some(details);
        self
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        let status = self.status;
        (status, Json(self)).into_response()
    }
}

// ── Convenience constructors ─────────────────────────────

// Some constructors cover API error codes not yet produced by any route but
// kept for a complete, stable constructor set.
#[allow(dead_code)]
impl ApiError {
    /// 403 — the vault is locked; the caller must unlock the desktop app.
    pub fn vault_locked() -> Self {
        Self::new(
            ApiErrorCode::VaultLocked,
            "Vault is locked — unlock the desktop app",
        )
    }
    /// 403 — the token's scope is too low for the requested operation.
    pub fn scope_insufficient(msg: impl Into<String>) -> Self {
        Self::new(ApiErrorCode::ScopeInsufficient, msg)
    }
    /// 404 — the requested page or resource does not exist.
    pub fn not_found(msg: impl Into<String>) -> Self {
        Self::new(ApiErrorCode::NotFound, msg)
    }
    /// 404 — no secret block with `label` on the page; echoes `label` in details.
    pub fn block_not_found(label: &str) -> Self {
        Self::new(
            ApiErrorCode::BlockNotFound,
            format!("Secret block not found: {label}"),
        )
        .with_details(serde_json::json!({ "label": label }))
    }
    pub fn label_conflict(label: &str) -> Self {
        Self::new(
            ApiErrorCode::LabelConflict,
            format!("Another block on this page already uses the label: {label}"),
        )
        .with_details(serde_json::json!({ "label": label }))
    }
    pub fn precondition_failed(current_etag: Option<&str>) -> Self {
        let mut e = Self::new(
            ApiErrorCode::PreconditionFailed,
            "If-Match header doesn't match current ETag — re-fetch and retry",
        );
        if let Some(t) = current_etag {
            e = e.with_details(serde_json::json!({ "current_etag": t }));
        }
        e
    }
    pub fn internal(msg: impl Into<String>) -> Self {
        Self::new(ApiErrorCode::InternalError, msg)
    }
    pub fn bad_request(msg: impl Into<String>) -> Self {
        Self::new(ApiErrorCode::BadRequest, msg)
    }
    /// Pairing was requested while no window is open.
    ///
    /// The message is deliberately identical whether the window never opened,
    /// has closed, or was just consumed — a caller must not be able to probe for
    /// one that is about to open.
    pub fn pairing_closed() -> Self {
        Self::new(
            ApiErrorCode::PairingClosed,
            "pairing is not open — ask Claspt to connect an extension first",
        )
    }

    pub fn not_ready(msg: impl Into<String>) -> Self {
        Self::new(ApiErrorCode::NotReady, msg)
    }
}

/// Helper to convert PageError into the standardized envelope.
impl From<crate::pages::error::PageError> for ApiError {
    fn from(e: crate::pages::error::PageError) -> Self {
        use crate::pages::error::PageError;
        match &e {
            PageError::NotFound(_) => Self::not_found(e.to_string()),
            PageError::VaultNotOpen => Self::vault_locked(),
            _ => Self::internal(e.to_string()),
        }
    }
}

/// Helper to convert PatchError (block-level operations) into the envelope.
impl From<crate::pages::secret::PatchError> for ApiError {
    fn from(e: crate::pages::secret::PatchError) -> Self {
        use crate::pages::secret::PatchError;
        match e {
            PatchError::BlockNotFound => Self::new(ApiErrorCode::BlockNotFound, e.to_string()),
            PatchError::LabelConflict => Self::new(ApiErrorCode::LabelConflict, e.to_string()),
            PatchError::InvalidInput => Self::new(ApiErrorCode::BadRequest, e.to_string()),
        }
    }
}
