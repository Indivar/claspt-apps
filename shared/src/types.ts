// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * types.ts — the shared domain vocabulary for Claspt.
 *
 * These interfaces and unions are the single contract that the desktop backend
 * (Rust, via `@/lib/commands`), the desktop frontend, the mobile app, the browser
 * extension, and the local HTTP API all speak. Many shapes mirror a Rust struct
 * exactly (e.g. {@link VaultConfig} ↔ `vault/config.rs`) — keep field names and
 * casing in sync with the Rust side, which is the validation boundary.
 *
 * Rough map of what lives here:
 *  - Page model: {@link PageMeta}, {@link Page}, {@link PageSummary},
 *    {@link SecretSummary}.
 *  - Local HTTP API contract: secret-block ops, {@link ApiStatus}/{@link ApiFeatures}
 *    (capability map — feature-detect, don't version-compare), {@link ApiError}/
 *    {@link ApiErrorCode}, {@link ListResponse}.
 *  - Config: {@link VaultConfig}.
 *  - Search: {@link SearchResult}, {@link SearchScope}.
 *  - History/import/media/sync/share and license/update/check payloads.
 */

/** Page metadata stored in YAML frontmatter. */
export interface PageMeta {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  pinned: boolean;
  archived: boolean;
  tags: string[];
  folder: string;
  encrypted: boolean;
  /**
   * Frontmatter lines this reader does not model (agent_ns, ttl_hours,
   * written_by_client, ...), kept verbatim so a save from any client leaves
   * another client's metadata exactly as it found it.
   */
  extra_frontmatter?: string[];
  /**
   * Agent-memory provenance the desktop backend serialises in full. Mobile
   * carries them inside `extra_frontmatter` instead, so both stay optional.
   */
  written_by_name?: string;
  /** False after an API client wrote the page, true once the owner reviewed it. */
  reviewed?: boolean;
}

/** A full page: metadata + markdown content + file path. */
export interface Page {
  meta: PageMeta;
  content: string;
  /** Relative path from vault root (e.g. "general/2026-02-21-143000-my-note.md"). */
  path: string;
}

/** Summary for sidebar list (no full content body). */
export interface PageSummary {
  meta: PageMeta;
  path: string;
  /** First ~200 chars of content for preview. */
  snippet: string;
}

/** A secret block summary: label + which page it belongs to. */
export interface SecretSummary {
  label: string;
  page_title: string;
  page_path: string;
  folder: string;
  created_at: string;
}

// ── Secret block operations (v2.0.0 — shared by desktop API + mobile native + extension) ──

/**
 * Decrypted secret block — label plus its key-value fields. Returned by
 * `GET /api/pages/{idOrPath}/secret` and the mobile equivalent.
 */
export interface SecretBlock {
  label: string;
  fields: Record<string, string>;
}

/**
 * Body of `PATCH /api/pages/{idOrPath}/secret` — non-destructive merge of
 * fields into a named secret block. Empty-string values delete the field.
 */
export interface SecretBlockPatch {
  label: string;
  fields: Record<string, string>;
  delete_fields?: string[];
  /** If true and no block matches `label`, append a new block. Default: false. */
  upsert?: boolean;
}

/** Body of `DELETE /api/pages/{idOrPath}/secret`. */
export interface SecretBlockDelete {
  label: string;
  /** If true and the block was the only meaningful content, delete the page entirely. */
  delete_page_if_empty?: boolean;
}

/** Body of `PATCH /api/pages/{idOrPath}/secret/rename`. */
export interface SecretBlockRename {
  old_label: string;
  new_label: string;
}

// ── Page lifecycle operations ──

/** Body of `PATCH /api/pages/{idOrPath}/move`. */
export interface PageMoveRequest {
  folder: string;
}

/** Body of `PATCH /api/pages/{idOrPath}/title`. */
export interface PageTitleRequest {
  title: string;
}

/** Body of `PATCH /api/pages/{idOrPath}/tags`. */
export interface PageTagsRequest {
  tags: string[];
}

// ── API status (v2.0.0 capability map) ──

/**
 * Capability map returned in `GET /api/status`. Clients should feature-detect
 * via this rather than version-comparing — features may be backported.
 */
export interface ApiFeatures {
  patch_secret: boolean;
  delete_secret: boolean;
  rename_secret: boolean;
  move_page: boolean;
  title_page: boolean;
  if_match: boolean;
  etag_timestamp: boolean;
  approval_flow: boolean;
  id_lookup: boolean;
  json_errors: boolean;
  source_attribution: boolean;
}

/** Response of `GET /api/status`. */
export interface ApiStatus {
  status: "ok";
  /** Desktop app semver. */
  version: string;
  /** Vault on-disk format version (integer; bumps on breaking format changes). */
  vault_format_version: number;
  /** Master key loaded? `false` means secret reads will return 403. */
  vault_unlocked: boolean;
  /** License tier or null if expired/missing. */
  plan: "Free" | "Trial" | "Pro" | "Pro+" | string | null;
  /** "desktop" when the app is serving, "headless" under `claspt serve`. */
  mode: "desktop" | "headless";
  features: ApiFeatures;
}

// ── Standard list response wrapper ──

/**
 * Paginated list response. All list endpoints in the v2.0.0 API return
 * this shape; bare arrays are not used.
 */
export interface ListResponse<T> {
  items: T[];
  /** Opaque cursor for the next page; null when no more results. */
  next_cursor?: string | null;
}

// ── Standard error response ──

/** Error payload returned by every non-2xx response. */
export interface ApiError {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export type ApiErrorCode =
  | "BAD_REQUEST"
  | "INVALID_PATH"
  | "UNAUTHORIZED"
  | "VAULT_LOCKED"
  | "SCOPE_INSUFFICIENT"
  | "APPROVAL_DENIED"
  | "NOT_FOUND"
  | "BLOCK_NOT_FOUND"
  | "LABEL_CONFLICT"
  | "PRECONDITION_FAILED"
  | "INTERNAL_ERROR"
  | "NOT_READY";

/** Vault configuration (matches Rust VaultConfig in vault/config.rs). */
export interface VaultConfig {
  vault_version: string;
  vault_id: string | null;
  theme: string;
  editor_font_size: number;
  editor_font_family: string;
  auto_save_delay_ms: number;
  clipboard_clear_seconds: number;
  secret_auto_hide_seconds: number;
  auto_lock_minutes: number;
  biometric_mode: string;
  sync_backend: string;
  sync_remote_url: string | null;
  sync_interval_seconds: number;
  license_key: string | null;
  last_opened_page_id: string | null;
  encrypted_page_display: string;
  ui_scale: number;
  markdown_extensions?: Record<string, boolean>;
  local_api_enabled?: boolean;
  local_api_port?: number;
  /** Serve an SSH agent from keys on pages tagged ssh-key. */
  ssh_agent_enabled?: boolean;
  /**
   * Legacy pre-scoped token (clsp_*).
   *
   * Normally `null`. API tokens live in the OS keychain; this field is only
   * populated on a machine with no usable credential store, or on a vault that
   * has not been unlocked since the move. Read tokens with `getApiTokens()`
   * rather than from here — this is a fallback location, not the source of truth.
   */
  local_api_token?: string | null;
  /** Notes-only token (clsn_*). See {@link VaultConfig.local_api_token} — normally `null`. */
  local_api_notes_token?: string | null;
  /** Full-access token (clss_*). See {@link VaultConfig.local_api_token} — normally `null`. */
  local_api_secrets_token?: string | null;
  /** Secret access mode: "auto" (default) or "approve" (require UI approval). */
  secret_access_mode?: string | null;
  /** Months of local API access log to keep; older month files are deleted. 1–120. */
  access_log_retention_months?: number;
  /** Secret reads one client may make per minute before being told to wait. 1–600. */
  secret_read_rate_limit_per_minute?: number;
  /** Remind to rotate passwords older than this many days; 0 = off. */
  rotation_reminder_days?: number;
  /** Default retention in days for agent memory by kind; 0 keeps forever. */
  memory_episodic_retention_days?: number;
  memory_semantic_retention_days?: number;
  memory_procedural_retention_days?: number;
  /** Ollama embedding model used to re-rank memory search; empty disables. */
  memory_rerank_model?: string;
  /** Where Ollama listens; loopback by default. */
  ollama_url?: string;
  /** Minutes before master key is zeroed (hard lock). 0 = never (until app quits). */
  key_lock_minutes?: number;
  inbox_enabled?: boolean;
  inbox_default_folder?: string;
  server_enabled?: boolean;
  /** Tracks app version when help pages were last written. */
  help_pages_version?: string | null;
  /** SHA-256 verification hash of the master key (hex), for recovery key validation. */
  master_key_verify?: string | null;
  /** Tracks which tour version the user has completed. null/undefined = never seen. */
  tour_version_seen?: number | null;
  /**
   * Which version of the first-run setup walkthrough this vault has seen.
   * `null` means it has not run. Stored per vault, so a newly created vault
   * runs it again.
   */
  setup_version_seen?: number | null;
  /** Saved window state for restore on next launch. */
  window_maximized?: boolean | null;
  window_width?: number | null;
  window_height?: number | null;
  window_x?: number | null;
  window_y?: number | null;
}

/** Search result. */
export interface SearchResult {
  page_id: string;
  title: string;
  snippet: string;
  folder: string;
  path: string;
  score: number;
}

/**
 * Search scope filter. Either everything (`"all"`), only secret labels
 * (`"secrets_only"`), or restricted to a single folder (`{ folder }`). Mirrors a
 * Rust enum, hence the internally-tagged object variant.
 */
export type SearchScope = "all" | { folder: string } | "secrets_only";

/** Git commit entry for version history. */
export interface CommitEntry {
  oid: string;
  message: string;
  timestamp: string;
}

/** Diff between a commit and its parent for a specific file. */
export interface CommitDiff {
  oid: string;
  message: string;
  timestamp: string;
  /** Content at the parent commit (null = file created at this commit). */
  parent_content: string | null;
  /** Content at this commit (null = file deleted at this commit). */
  current_content: string | null;
}

/** Vault creation result. */
export interface VaultCreationResult {
  recovery_key: string;
}

/**
 * Import format identifier — selects the parser used for a bulk import. The
 * password-manager formats have fixed column layouts; `GenericCsv` uses the
 * user-provided {@link CsvColumnMapping}s; `Markdown` imports a single `.md` file.
 */
export type ImportFormat =
  | "LastPass"
  | "OnePassword"
  | "RoboForm"
  | "KeePass"
  | "GenericCsv"
  | "Markdown";

/** Auto-detected column mapping for Generic CSV import. */
export interface CsvColumnMapping {
  header: string;
  /** One of: "title", "username", "password", "email", "url", "otp", "notes", "folder", "field", "skip" */
  role: string;
}

/** How to handle duplicate entries during bulk import. */
export type DuplicateStrategy = "skip" | "overwrite" | "import_as_new";

/** Preview metadata from a markdown file import. */
export interface MarkdownImportPreview {
  title: string;
  suggested_folder: string;
  tags: string[];
  has_frontmatter: boolean;
  has_secrets: boolean;
  has_media_refs: boolean;
  word_count: number;
  content_preview: string;
  warnings: string[];
  duplicate_exists: boolean;
}

/** A single import entry for preview. */
export interface ImportEntry {
  title: string;
  folder: string;
  fields: ImportField[];
  notes: string;
}

export interface ImportField {
  key: string;
  value: string;
}

/** Import result with duplicate tracking. */
export interface ImportResult {
  imported: number;
  skipped: number;
  total: number;
}

/** Parameters for image transformation. */
export interface ImageTransformParams {
  format: string;
  width: number | null;
  height: number | null;
  percent: number | null;
  rotation: number;
  quality: number;
}

/** Preview result from image transform. */
export interface ImageTransformPreview {
  original_width: number;
  original_height: number;
  original_size: number;
  original_format: string;
  output_width: number;
  output_height: number;
  output_size: number;
  preview_data_url: string;
}

/** Sync engine status. */
export interface SyncStatus {
  backend: string;
  state: SyncState;
  last_sync: string | null;
  last_error: string | null;
  pending_conflicts: number;
}

/** Current phase of the sync engine, surfaced in {@link SyncStatus.state}. */
export type SyncState = "Idle" | "Pushing" | "Pulling" | "Error" | "Disabled";

/** Sync operation result. */
export interface SyncResult {
  success: boolean;
  files_changed: number;
  conflicts: ConflictInfo[];
  message: string;
}

/** A sync conflict to resolve. */
export interface ConflictInfo {
  path: string;
  local_content: string;
  remote_content: string;
}

/**
 * How to resolve a sync conflict: take the local version, take the remote
 * version, or keep both (writing the remote copy alongside as a new file).
 */
export type SyncResolution = "KeepLocal" | "KeepRemote" | "KeepBoth";

// ── Share ──────────────────────────────────────────────

/** Result of creating a share (upload to server). */
export interface ShareCreateResult {
  id: string;
  url: string;
  package_json: string;
}

/** Preview of a share before decryption. */
export interface SharePreview {
  id: string;
  title: string;
  share_type: string;
  created_at: string;
  expires_at: string | null;
  expired: boolean;
}

/** A secret field in a share. */
export interface ShareSecretField {
  key: string;
  value: string;
}

/** Decrypted page payload from a share. */
export interface SharePagePayload {
  title: string;
  tags: string[];
  folder: string;
  content: string;
  expires_at: string | null;
}

/** Decrypted secret payload from a share. */
export interface ShareSecretPayload {
  label: string;
  fields: ShareSecretField[];
  expires_at: string | null;
}

/** Decrypted share content — either a page or a secret. */
export type DecryptedShare =
  | ({ type: "page" } & SharePagePayload)
  | ({ type: "secret" } & ShareSecretPayload);

// ── Unified Check ──────────────────────────────────────

/** A pending share from the check endpoint. */
export interface PendingShare {
  id: string;
  title: string;
  share_type: string;
  from_device: string;
  created_at: string;
  expires_at: string;
  /** Present for passwordless shares — the server holds the password so the recipient can auto-decrypt. */
  share_password?: string;
  /** If true, the share is consumed (deleted) after first download. */
  burn_after_reading?: boolean;
}

/** App update info from the check endpoint. */
export interface UpdateInfo {
  version: string;
  url: string;
  notes: string;
  signature: string | null;
}

/** License validation from the check endpoint. */
export interface CheckLicenseStatus {
  valid: boolean;
  message: string | null;
}

/** Combined check response. */
export interface CheckResponse {
  shares: PendingShare[];
  update: UpdateInfo | null;
  license: CheckLicenseStatus | null;
}

/** Email registration state from the backend. */
export interface EmailState {
  email: string | null;
  verified: boolean;
}

/** License status returned from the backend. */
export interface LicenseStatus {
  is_pro: boolean;
  tier: string | null;
  email: string | null;
  expires_at: string | null;
  days_remaining: number | null;
  is_trial: boolean;
  is_expired: boolean;
}
