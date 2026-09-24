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
  /** The page's tags, so a capture not yet confirmed can be told apart. */
  tags?: string[];
  /** Taken into the vault at submit time and not yet confirmed by the owner. */
  captured?: boolean;
}

/** A login taken straight into the vault at submit time, not yet confirmed. */
export interface CapturedItem {
  pagePath: string;
  title: string;
  username: string;
  domain: string;
  url: string;
  capturedAt: string;
}

/** What happened to the last submission on a site. */
export type CaptureOutcome =
  | "captured"
  | "parked"
  | "already_saved"
  | "never_save"
  | "excluded"
  | "failed";

export interface LastCapture {
  outcome: CaptureOutcome;
  username: string;
  at: number;
  pagePath?: string;
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
  | {
      type: "STATUS_RESULT";
      connected: boolean;
      vaultUnlocked: boolean;
      version?: string;
      vaultFormatVersion?: number;
      vaultSyncVersion?: number;
      plan?: string;
      permissionNeeded?: boolean;
      desktopTooOld?: boolean;
      /** The app is running but does not know this extension's token. */
      tokenRejected?: boolean;
      features?: ApiFeatures;
    }
  | { type: "CHECK_HOST_PERMISSION" }
  | { type: "HOST_PERMISSION_RESULT"; granted: boolean }
  | { type: "GET_CREDENTIALS"; domain: string }
  | {
      type: "CREDENTIALS_RESULT";
      credentials: Credential[];
      /** Why the list may be empty, so the picker can say so instead of "no matches". */
      reason?: Exclude<ConnectionState, "connected">;
    }
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
      result?:
        | import("./passkey-codec").RegistrationResult
        | import("./passkey-codec").AssertionResult;
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
      reason?: "not-open" | "desktop-too-old" | "unreachable" | "no-permission";
      scope?: "notes" | "secrets";
    }
  | { type: "CONFIG_SAVED" }
  | {
      type: "GENERATE_PASSWORD";
      length?: number;
      uppercase?: boolean;
      lowercase?: boolean;
      digits?: boolean;
      symbols?: boolean;
    }
  | { type: "PASSWORD_RESULT"; password: string }
  | { type: "GET_PASSKEYS"; domain: string }
  | { type: "PASSKEYS_RESULT"; count: number; accounts: string[] }
  | { type: "CLIPBOARD_WRITTEN"; ok: boolean }
  | { type: "SCAN_QR" }
  | {
      type: "QR_SCAN_RESULT";
      found: boolean;
      uri?: string;
      issuer?: string;
      account?: string;
      reason?: "no-qr" | "not-totp" | "capture-failed";
    }
  | { type: "GENERATE_TOTP"; secret: string }
  | { type: "TOTP_RESULT"; code: string; remaining: number; period: number }
  | {
      type: "SAVE_CREDENTIAL";
      username: string;
      password: string;
      url: string;
      domain: string;
      /** From the Add new form: the block label, every field by its written
       *  name, and the template's tag. Absent from the content script's
       *  save bar, which knows only a login. */
      label?: string;
      fields?: Record<string, string>;
      template?: string;
    }
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
  /**
   * Fill personal details into the page's address or signup form.
   *
   * This was sent by the popup for a long time with nothing listening for it
   * and no entry here, so the Fill button did nothing at all. `chrome.tabs
   * .sendMessage` takes `any`, so neither the compiler nor a test noticed.
   */
  | { type: "FILL_IDENTITY"; identity: Record<string, string>; pagePath?: string }
  | { type: "FILL_IDENTITY_RESULT"; filled: number }
  /**
   * Remember which identity was used on a site, so the next visit offers it
   * first. Only the page path is kept — a reference into the vault, never a
   * name, address or any other value.
   */
  | { type: "REMEMBER_IDENTITY_FOR_SITE"; host: string; pagePath: string }
  | { type: "IDENTITY_FOR_SITE"; host: string }
  | { type: "IDENTITY_FOR_SITE_RESULT"; pagePath: string | null }
  /** Identities for the in-field picker: no cards, best match for this site first. */
  | { type: "LIST_IDENTITIES_FOR_SITE"; host: string }
  | {
      type: "LIST_IDENTITIES_FOR_SITE_RESULT";
      items: Array<{ pagePath: string; title: string; fields: Record<string, string> }>;
    }
  | { type: "OPEN_IN_DESKTOP"; pagePath: string }
  | { type: "OPEN_IN_DESKTOP_RESULT"; success: boolean }
  | { type: "TRIGGER_GENERATE_INTO_FIELD"; tabId?: number }
  // ── v2.0.0 granular CRUD (uses the new desktop API endpoints) ──
  | {
      type: "PATCH_SECRET_BLOCK";
      pagePath: string;
      label: string;
      fields: Record<string, string>;
      deleteFields?: string[];
      ifMatch?: string;
    }
  // ── Generated-password history (vault-backed) ──
  | { type: "RECORD_GENERATED_PASSWORD"; password: string; site?: string }
  | {
      type: "RECORD_GENERATED_PASSWORD_RESULT";
      success: boolean;
      pagePath?: string;
      label?: string;
      /** The vault was out of reach; the worker holds the password until it is back. */
      parked?: boolean;
    }
  // ── Session records held by the worker for content scripts ──
  // Content scripts cannot touch session storage themselves: the worker owns
  // it and binds every record to the site the sender is on.
  | { type: "PENDING_SAVE_SET"; credentials: Omit<PendingSave, "timestamp" | "domain"> }
  | { type: "PENDING_SAVE_GET" }
  | { type: "PENDING_SAVE_RESULT"; pending: PendingSave | null }
  | { type: "PENDING_SAVE_CLEAR" }
  | { type: "PENDING_SAVE_PARK" }
  | { type: "STEP_USERNAME_SET"; value: string }
  | { type: "STEP_USERNAME_GET" }
  | { type: "STEP_USERNAME_CLEAR" }
  | { type: "STEP_USERNAME_RESULT"; value: string | null }
  | { type: "SESSION_OK"; ok: boolean }
  | { type: "MARK_GENERATED_USED"; pagePath: string; label: string }
  | { type: "MARK_GENERATED_USED_RESULT"; success: boolean }
  | { type: "LIST_GENERATED_PASSWORDS" }
  | { type: "LIST_GENERATED_PASSWORDS_RESULT"; entries: StoredGeneratedEntry[] }
  | { type: "CLEAR_UNUSED_GENERATED"; days: number }
  | { type: "CLEAR_UNUSED_GENERATED_RESULT"; success: boolean; removed: number }
  | {
      type: "PATCH_SECRET_BLOCK_RESULT";
      success: boolean;
      etag?: string | null;
      errorCode?: string;
      errorMessage?: string;
    }
  | {
      type: "DELETE_SECRET_BLOCK";
      pagePath: string;
      label: string;
      deletePageIfEmpty?: boolean;
      ifMatch?: string;
    }
  | {
      type: "DELETE_SECRET_BLOCK_RESULT";
      success: boolean;
      pageDeleted?: boolean;
      errorCode?: string;
      errorMessage?: string;
    }
  | {
      type: "RENAME_SECRET_BLOCK";
      pagePath: string;
      oldLabel: string;
      newLabel: string;
      ifMatch?: string;
    }
  | {
      type: "RENAME_SECRET_BLOCK_RESULT";
      success: boolean;
      etag?: string | null;
      errorCode?: string;
      errorMessage?: string;
    }
  | { type: "MOVE_PAGE"; pagePath: string; folder: string }
  | {
      type: "MOVE_PAGE_RESULT";
      success: boolean;
      newPath?: string;
      errorCode?: string;
      errorMessage?: string;
    }
  | { type: "LIST_FOLDERS" }
  | {
      type: "LIST_FOLDERS_RESULT";
      success: boolean;
      folders: string[];
      errorCode?: string;
      errorMessage?: string;
    }
  /**
   * A submitted login goes into the vault the moment it is captured, as a
   * page tagged "captured", so no redirect, second factor, lock or crash can
   * lose it. Confirm keeps it as an ordinary login; discard sends it to the
   * trash. From a page, only the site the browser says the message came from.
   */
  | { type: "CAPTURE_LOGIN"; username: string; password: string; url: string; isSignup: boolean }
  | {
      type: "CAPTURE_RESULT";
      success: boolean;
      pagePath?: string;
      /** Held in memory until the desktop is reachable again. */
      parked?: boolean;
      /** The password went onto a capture for the same account already there. */
      updatedExisting?: boolean;
    }
  /** Without a page path: the capture parked for the sender's site and this account. */
  | { type: "CONFIRM_CAPTURE"; pagePath?: string; username?: string; title?: string }
  | { type: "CONFIRM_CAPTURE_RESULT"; success: boolean }
  | { type: "DISCARD_CAPTURE"; pagePath?: string; username?: string }
  | { type: "DISCARD_CAPTURE_RESULT"; success: boolean }
  | { type: "LIST_CAPTURED" }
  | { type: "CAPTURED_RESULT"; items: CapturedItem[]; parked: number }
  | { type: "LAST_CAPTURE_SET"; capture: Omit<LastCapture, "at"> }
  | { type: "LAST_CAPTURE_GET"; domain?: string }
  | { type: "LAST_CAPTURE_RESULT"; capture: LastCapture | null }
  | { type: "GET_PAGE_WITH_ETAG"; pagePath: string }
  | {
      type: "GET_PAGE_WITH_ETAG_RESULT";
      success: boolean;
      page?: Page;
      etag?: string | null;
      errorCode?: string;
    };

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
export type ConnectionState =
  | "connected"
  | "disconnected"
  | "vault_locked"
  | "permission_needed"
  | "desktop_too_old"
  /** The app answered and refused this extension's token: pair again. */
  | "unauthorized";

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

/**
 * A login captured on a page and not yet saved. Held by the background
 * worker in memory-backed session storage while a redirect or a second
 * factor completes, then offered again on the same site only.
 */
export interface PendingSave {
  username: string;
  password: string;
  url: string;
  domain: string;
  isSignup: boolean;
  timestamp: number;
  /** Where the capture was written in the vault, once it was. */
  pagePath?: string;
}

/** A captured login the user dismissed without saving; listed in the popup. */
export interface UnsavedCredential {
  username: string;
  password: string;
  url: string;
  domain: string;
  timestamp: number;
}
