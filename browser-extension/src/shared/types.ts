// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import type { StoredGeneratedEntry } from "@claspt/shared/generated-history";

/** Configuration stored in chrome.storage.local */
export interface ExtensionConfig {
  port: number;
  token: string;
  clipboardTimeout: number; // seconds, 0 = never
  autoFillEnabled: boolean;
  /** Auto-lock after N minutes of idle. 0 = never. */
  autoLockMinutes: number;
  /** Lock when browser closes */
  lockOnBrowserClose: boolean;
  /** Auto-fill on page load (without clicking icon) */
  autoFillOnPageLoad: boolean;
  /** Show field highlight flash after filling */
  showFillFlash: boolean;
  /** Auto-paste TOTP code after filling password */
  autoFillTotp: boolean;
  /**
   * Sites Claspt stays out of entirely: no inline icons, no auto-fill, no save
   * bar, no credentials returned to the page.
   *
   * A `phishingWarnings` and an `iframeProtection` flag used to sit here.
   * Nothing read either one, and neither should be optional: domain checking
   * and the refusal to fill inside a frame are now unconditional.
   */
  excludedDomains: string[];
  /** Show onboarding on first install */
  onboardingComplete: boolean;
}

export const DEFAULT_CONFIG: ExtensionConfig = {
  port: 9315,
  token: "",
  clipboardTimeout: 30,
  autoFillEnabled: true,
  autoLockMinutes: 15,
  lockOnBrowserClose: true,
  autoFillOnPageLoad: false,
  showFillFlash: true,
  autoFillTotp: true,
  excludedDomains: [],
  onboardingComplete: false,
};

/** Recently used credential entry */
export interface RecentCredential {
  pagePath: string;
  label: string;
  domain: string;
  username: string;
  timestamp: number;
}

/** URL matching mode per credential */
export type UrlMatchMode = "base_domain" | "host" | "exact" | "never";

/** API /api/status response — extended in v2.0.0 with format version + features */
export interface ApiStatus {
  status: string;
  /** Desktop app semver. */
  version: string;
  /** Vault on-disk format version (integer). Bumps on breaking format changes. */
  vault_format_version?: number;
  /** Vault sync revision — same number shown in desktop's footer (`v{n}`).
   *  Sourced from the desktop's `sync.json::last_synced_version`.
   *  Omitted when sync is not configured. */
  vault_sync_version?: number;
  vault_unlocked: boolean;
  plan?: string;
  /** Capability map — feature-detect rather than version-comparing (1.x desktops omit this). */
  features?: ApiFeatures;
}

/** Capability map returned in `GET /api/status.features` (v2.0.0+) */
export interface ApiFeatures {
  patch_secret?: boolean;
  delete_secret?: boolean;
  rename_secret?: boolean;
  move_page?: boolean;
  title_page?: boolean;
  if_match?: boolean;
  etag_timestamp?: boolean;
  approval_flow?: boolean;
  id_lookup?: boolean;
  json_errors?: boolean;
  source_attribution?: boolean;
}

/** A decrypted secret block — label + key-value fields. */
export interface SecretBlock {
  label: string;
  fields: Record<string, string>;
}

/** Body of PATCH /api/pages/{idOrPath}/secret — non-destructive merge. */
export interface SecretBlockPatch {
  label: string;
  fields: Record<string, string>;
  delete_fields?: string[];
  /** If true and no block matches `label`, append a new block. Default: false. */
  upsert?: boolean;
}

/** Body of DELETE /api/pages/{idOrPath}/secret. */
export interface SecretBlockDelete {
  label: string;
  delete_page_if_empty?: boolean;
}

/** Body of PATCH /api/pages/{idOrPath}/secret/rename. */
export interface SecretBlockRename {
  old_label: string;
  new_label: string;
}

/** Standard error envelope returned by the v2.0.0 desktop API. */
export interface ApiErrorEnvelope {
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

/** Parsed credential from a secret block */
export interface Credential {
  /** Page file path (relative to vault root) */
  pagePath: string;
  /** Page title from frontmatter */
  pageTitle: string;
  /** Secret block label, e.g. "GitHub Login" */
  label: string;
  /** Parsed key-value fields from secret block */
  fields: Record<string, string>;
  /** URL field if present */
  url?: string;
  /** Relevance score from URL matching (higher = better match) */
  score?: number;
}

/** Search result from /api/search */
export interface SearchResult {
  path: string;
  title: string;
  snippet: string;
  score: number;
  secret_labels?: string[];
}

/** Page metadata from API */
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
}

/** Full page from GET /api/pages/:path */
export interface Page {
  meta: PageMeta;
  content: string;
  path: string;
}

/** Page summary from GET /api/pages (list endpoint) */
export interface PageSummary {
  meta: PageMeta;
  path: string;
  snippet: string;
}

/** Domain preference for auto-fill */
export interface DomainPref {
  preferredLabel?: string;
  preferredPagePath?: string;
  autoFillEnabled: boolean;
  neverSave?: boolean;
}

/** Messages between popup/content and background */
export type Message =
  | { type: "GET_STATUS" }
  | { type: "STATUS_RESULT"; connected: boolean; vaultUnlocked: boolean; version?: string; vaultFormatVersion?: number; vaultSyncVersion?: number; plan?: string; permissionNeeded?: boolean; features?: ApiFeatures }
  | { type: "CHECK_HOST_PERMISSION" }
  | { type: "HOST_PERMISSION_RESULT"; granted: boolean }
  | { type: "GET_CREDENTIALS"; domain: string }
  | { type: "CREDENTIALS_RESULT"; credentials: Credential[] }
  | { type: "SEARCH_CREDENTIALS"; query: string }
  | { type: "SEARCH_RESULT"; credentials: Credential[] }
  | { type: "COPY_TO_CLIPBOARD"; text: string; autoClear: boolean }
  | { type: "COPY_RESULT"; success: boolean }
  | { type: "COPY_TO_CLIPBOARD_SCHEDULE_CLEAR" }
  | { type: "FILL_CREDENTIAL"; credential: Credential; submit?: boolean }
  | { type: "FILL_RESULT"; success: boolean }
  /** Passkeys: from the content-script bridge to the background. */
  | { type: "PASSKEY_CREATE"; request: import("./passkey-codec").PasskeyCreateRequest }
  | { type: "PASSKEY_GET"; request: import("./passkey-codec").PasskeyGetRequest }
  | {
      type: "PASSKEY_RESULT";
      outcome: "done" | "fallback" | "error";
      result?: import("./passkey-codec").RegistrationResult | import("./passkey-codec").AssertionResult;
      error?: string;
    }
  | { type: "PASSKEY_CHOOSE"; candidates: import("./passkey-codec").PasskeyCandidate[] }
  /** Ask the desktop app for a token while its pairing window is open. */
  | { type: "PAIR_WITH_APP" }
  | { type: "GET_CONFIG" }
  | { type: "CONFIG_RESULT"; config: ExtensionConfig }
  | { type: "SAVE_CONFIG"; config: ExtensionConfig }
  | {
      type: "PAIR_RESULT";
      ok: boolean;
      /** Why it failed, when it did. */
      reason?: "not-open" | "unreachable" | "no-permission";
      scope?: "notes" | "secrets";
    }
  | { type: "CONFIG_SAVED" }
  | { type: "GENERATE_PASSWORD"; length?: number; uppercase?: boolean; lowercase?: boolean; digits?: boolean; symbols?: boolean }
  | { type: "PASSWORD_RESULT"; password: string }
  | { type: "GENERATE_TOTP"; secret: string }
  | { type: "TOTP_RESULT"; code: string; remaining: number }
  | { type: "SAVE_CREDENTIAL"; username: string; password: string; url: string; domain: string }
  | { type: "SAVE_CREDENTIAL_RESULT"; success: boolean }
  | { type: "CHECK_EXISTING"; domain: string }
  | { type: "CHECK_EXISTING_RESULT"; credentials: Credential[] }
  | { type: "SET_DOMAIN_PREF"; domain: string; pref: DomainPref }
  | { type: "DOMAIN_PREF_SAVED" }
  | { type: "GET_DOMAIN_PREF"; domain: string }
  | { type: "DOMAIN_PREF_RESULT"; pref: DomainPref | null }
  | { type: "UPDATE_BADGE"; tabId: number; count: number }
  | { type: "SAVE_IDENTITY"; title: string; content: string; tags: string[] }
  | { type: "SAVE_IDENTITY_RESULT"; success: boolean }
  | { type: "UPDATE_IDENTITY"; pagePath: string; content: string }
  | { type: "UPDATE_IDENTITY_RESULT"; success: boolean }
  | { type: "LIST_IDENTITIES" }
  | { type: "LIST_IDENTITIES_RESULT"; items: IdentityItem[] }
  | { type: "OPEN_IN_DESKTOP"; pagePath: string }
  | { type: "OPEN_IN_DESKTOP_RESULT"; success: boolean }
  | { type: "TRIGGER_GENERATE_INTO_FIELD"; tabId?: number }
  // ── v2.0.0 granular CRUD (uses the new desktop API endpoints) ──
  | { type: "PATCH_SECRET_BLOCK"; pagePath: string; label: string; fields: Record<string, string>; deleteFields?: string[]; ifMatch?: string }
  // ── Generated-password history (vault-backed) ──
  | { type: "RECORD_GENERATED_PASSWORD"; password: string; site?: string }
  | { type: "RECORD_GENERATED_PASSWORD_RESULT"; success: boolean; pagePath?: string; label?: string }
  | { type: "MARK_GENERATED_USED"; pagePath: string; label: string }
  | { type: "MARK_GENERATED_USED_RESULT"; success: boolean }
  | { type: "LIST_GENERATED_PASSWORDS" }
  | { type: "LIST_GENERATED_PASSWORDS_RESULT"; entries: StoredGeneratedEntry[] }
  | { type: "CLEAR_UNUSED_GENERATED"; days: number }
  | { type: "CLEAR_UNUSED_GENERATED_RESULT"; success: boolean; removed: number }
  | { type: "PATCH_SECRET_BLOCK_RESULT"; success: boolean; etag?: string | null; errorCode?: string; errorMessage?: string }
  | { type: "DELETE_SECRET_BLOCK"; pagePath: string; label: string; deletePageIfEmpty?: boolean; ifMatch?: string }
  | { type: "DELETE_SECRET_BLOCK_RESULT"; success: boolean; pageDeleted?: boolean; errorCode?: string; errorMessage?: string }
  | { type: "RENAME_SECRET_BLOCK"; pagePath: string; oldLabel: string; newLabel: string; ifMatch?: string }
  | { type: "RENAME_SECRET_BLOCK_RESULT"; success: boolean; etag?: string | null; errorCode?: string; errorMessage?: string }
  | { type: "MOVE_PAGE"; pagePath: string; folder: string }
  | { type: "MOVE_PAGE_RESULT"; success: boolean; newPath?: string; errorCode?: string; errorMessage?: string }
  | { type: "LIST_FOLDERS" }
  | { type: "LIST_FOLDERS_RESULT"; success: boolean; folders: string[]; errorCode?: string; errorMessage?: string }
  | { type: "GET_PAGE_WITH_ETAG"; pagePath: string }
  | { type: "GET_PAGE_WITH_ETAG_RESULT"; success: boolean; page?: Page; etag?: string | null; errorCode?: string };

/** A grouped identity or credit card item — one per page in identities/ folder. */
export interface IdentityItem {
  /** Page path in vault */
  pagePath: string;
  /** Page title (e.g., "NZ Identity", "Visa") */
  title: string;
  /** Item type derived from page tags */
  itemType: "identity" | "card";
  /** All fields merged from all secret blocks in this page */
  fields: Record<string, string>;
  /** Individual secret block labels (for display) */
  blockLabels: string[];
}

/** Identity profile for form auto-fill */
export interface IdentityProfile {
  personal: Record<string, string>;
  address: Record<string, string>;
  creditCards: Array<Record<string, string>>;
}

/** Connection state for the popup UI */
export type ConnectionState = "connected" | "disconnected" | "vault_locked" | "permission_needed";

/**
 * A one-shot "log me in" job from the desktop: an agent asked, the owner
 * approved in the app, and the credential rides along for this fill only.
 * The extension fills the form and reports back; nothing is stored.
 */
export interface LoginJob {
  id: string;
  /** Login page to open first; absent means the active tab. */
  url?: string;
  submit: boolean;
  requestedBy: string;
  credential: Credential;
}
