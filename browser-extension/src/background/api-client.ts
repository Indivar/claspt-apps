// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import type {
  AssertionResult,
  PasskeyCandidate,
  PasskeyCreateRequest,
  PasskeyGetRequest,
  RegistrationResult,
} from "@/shared/passkey-codec";
import type {
  ApiErrorCode,
  ApiErrorEnvelope,
  ApiStatus,
  ExtensionConfig,
  Page,
  PageSummary,
  SearchResult,
  SecretBlock,
  SecretBlockDelete,
  SecretBlockPatch,
  SecretBlockRename, LoginJob } from "@/shared/types";

/**
 * HTTP client for the Claspt local API (127.0.0.1).
 *
 * v2.0.0 contract:
 * - JSON error envelope `{error: {code, message, details?}}` on every non-2xx
 * - Standardized list envelope `{items, next_cursor?}` on list endpoints
 * - `If-Match` / `ETag` for last-write-wins concurrency (desktop always wins)
 * - `X-Claspt-Source: extension/{origin}` header for auto-commit attribution
 * - `id` OR `path` accepted on every page-addressed endpoint
 *
 * Backward-compatible with 1.x desktops: when the server returns plain-text
 * errors or bare-array list responses, the client adapts (see `parseError`
 * and `unwrapList`). Feature detection happens via `getStatus().features`.
 */
export class ApiClient {
  private baseUrl: string;
  private token: string;
  /**
   * Set per-call by the message-handler so background-issued requests get
   * attributed to the originating tab's hostname (e.g. `extension/github.com`).
   * Tracking it here vs. plumbing through every method keeps the signatures clean.
   */
  private sourceHint: string | null = null;

  constructor(config: ExtensionConfig) {
    this.baseUrl = buildLocalBaseUrl(config.port);
    this.token = config.token;
  }

  updateConfig(config: ExtensionConfig) {
    this.baseUrl = buildLocalBaseUrl(config.port);
    this.token = config.token;
  }

  /**
   * Drop the in-memory bearer token. Called on auto-lock to shrink the window
   * in which the running service worker holds the local-API credential.
   *
   * SECURITY NOTE / KNOWN CONSTRAINT: the token is a long-lived bearer minted
   * by the Claspt desktop app and pasted in by the user. The companion model
   * REQUIRES it to persist in chrome.storage.local so the extension can silently
   * reconnect after the browser restarts or the worker is evicted — we cannot
   * wipe it from storage on auto-lock without breaking auto-reconnect, and the
   * extension has no way to rotate it (that needs a desktop-side change). To
   * limit blast radius we (a) only ever send it to 127.0.0.1 (see
   * buildLocalBaseUrl), (b) never log the token value, and (c) clear this
   * in-memory copy on lock. A short-TTL / rotating token issued by the desktop
   * is the proper long-term fix.
   */
  clearToken() {
    this.token = "";
  }

  /** Whether an in-memory bearer token is currently held. */
  hasToken(): boolean {
    return this.token.length > 0;
  }

  /** Set the X-Claspt-Source attribution for the next request batch. */
  setSourceHint(hint: string | null) {
    this.sourceHint = hint;
  }

  private async request<T>(
    path: string,
    options?: RequestInit & { ifMatch?: string },
  ): Promise<{ data: T; etag: string | null }> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.token) headers["Authorization"] = `Bearer ${this.token}`;
    if (options?.ifMatch) headers["If-Match"] = options.ifMatch;
    if (this.sourceHint) headers["X-Claspt-Source"] = `extension/${this.sourceHint}`;

    const res = await fetch(url, {
      ...options,
      headers: { ...headers, ...options?.headers },
    });

    const etag = res.headers.get("etag");

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw await parseError(res.status, text, etag);
    }

    if (res.status === 204) {
      return { data: {} as T, etag };
    }

    const text = await res.text();
    if (!text) return { data: {} as T, etag };
    return { data: JSON.parse(text) as T, etag };
  }

  // ── Status ────────────────────────────────────────────

  async getStatus(): Promise<ApiStatus> {
    const { data } = await this.request<ApiStatus>("/api/status");
    return data;
  }

  // ── Search ────────────────────────────────────────────

  async search(query: string, scope: "all" | "secrets" = "secrets"): Promise<SearchResult[]> {
    const params = new URLSearchParams({ q: query, scope });
    const { data } = await this.request<unknown>(`/api/search?${params}`);
    return unwrapList<SearchResult>(data);
  }

  // ── Pages ─────────────────────────────────────────────

  /** Get a single page with decrypted secrets. Accepts ID or path. */
  async getPage(pathOrId: string): Promise<Page> {
    const { data } = await this.request<Page>(`/api/pages/${encodeURIComponent(pathOrId)}`);
    return data;
  }

  /** Get a page along with its ETag — for callers that need optimistic concurrency. */
  async getPageWithEtag(pathOrId: string): Promise<{ page: Page; etag: string | null }> {
    const { data, etag } = await this.request<Page>(`/api/pages/${encodeURIComponent(pathOrId)}`);
    return { page: data, etag };
  }

  /** List all pages, optionally filtered by folder. */
  async listPages(folder?: string): Promise<PageSummary[]> {
    const params = folder ? `?folder=${encodeURIComponent(folder)}` : "";
    const { data } = await this.request<unknown>(`/api/pages${params}`);
    return unwrapList<PageSummary>(data);
  }

  /** Create a new page. */
  async createPage(body: {
    title: string;
    content: string;
    folder?: string;
    tags?: string[];
  }): Promise<Page> {
    const { data } = await this.request<Page>("/api/pages", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return data;
  }

  /** Replace a page's full content (destructive — prefer patchSecretBlock for credential edits). */
  async updatePage(pathOrId: string, body: { content: string }, ifMatch?: string): Promise<Page> {
    const { data } = await this.request<Page>(`/api/pages/${encodeURIComponent(pathOrId)}`, {
      method: "PUT",
      body: JSON.stringify(body),
      ifMatch,
    });
    return data;
  }

  /** Delete a page entirely. */
  async deletePage(pathOrId: string, ifMatch?: string): Promise<void> {
    await this.request<void>(`/api/pages/${encodeURIComponent(pathOrId)}`, {
      method: "DELETE",
      ifMatch,
    });
  }

  // ── Secret blocks (granular, v2.0.0) ──────────────────

  /** Non-destructive merge of fields into a named secret block. */
  async patchSecretBlock(
    pathOrId: string,
    body: SecretBlockPatch,
    ifMatch?: string,
  ): Promise<{ page: Page; etag: string | null }> {
    const { data, etag } = await this.request<Page>(
      `/api/pages/${encodeURIComponent(pathOrId)}/secret`,
      { method: "PATCH", body: JSON.stringify(body), ifMatch },
    );
    return { page: data, etag };
  }

  /** Remove a single secret block. Returns null if the page was deleted (only block + delete_page_if_empty). */
  async deleteSecretBlock(
    pathOrId: string,
    body: SecretBlockDelete,
    ifMatch?: string,
  ): Promise<{ page: Page | null; etag: string | null }> {
    const { data, etag } = await this.request<Page>(
      `/api/pages/${encodeURIComponent(pathOrId)}/secret`,
      { method: "DELETE", body: JSON.stringify(body), ifMatch },
    );
    // If the response was 204 the data will be {} — surface as null.
    const page = data && typeof data === "object" && "meta" in data ? data : null;
    return { page, etag };
  }

  /** Change a secret block's label without touching its fields. */
  async renameSecretBlock(
    pathOrId: string,
    body: SecretBlockRename,
    ifMatch?: string,
  ): Promise<{ page: Page; etag: string | null }> {
    const { data, etag } = await this.request<Page>(
      `/api/pages/${encodeURIComponent(pathOrId)}/secret/rename`,
      { method: "PATCH", body: JSON.stringify(body), ifMatch },
    );
    return { page: data, etag };
  }

  /** List secret blocks in a page (Notes scope: redacted; Secrets scope: full). */
  async listSecretBlocks(pathOrId: string): Promise<SecretBlock[]> {
    const { data } = await this.request<unknown>(
      `/api/pages/${encodeURIComponent(pathOrId)}/secret`,
    );
    return unwrapList<SecretBlock>(data);
  }

  // ── Page lifecycle (v2.0.0) ───────────────────────────

  async movePage(pathOrId: string, folder: string): Promise<Page> {
    const { data } = await this.request<Page>(
      `/api/pages/${encodeURIComponent(pathOrId)}/move`,
      { method: "PATCH", body: JSON.stringify({ folder }) },
    );
    return data;
  }

  async updateTitle(pathOrId: string, title: string): Promise<Page> {
    const { data } = await this.request<Page>(
      `/api/pages/${encodeURIComponent(pathOrId)}/title`,
      { method: "PATCH", body: JSON.stringify({ title }) },
    );
    return data;
  }

  async updateTags(pathOrId: string, tags: string[]): Promise<Page> {
    const { data } = await this.request<Page>(
      `/api/pages/${encodeURIComponent(pathOrId)}/tags`,
      { method: "PATCH", body: JSON.stringify({ tags }) },
    );
    return data;
  }

  async togglePin(pathOrId: string): Promise<Page> {
    const { data } = await this.request<Page>(
      `/api/pages/${encodeURIComponent(pathOrId)}/pin`,
      { method: "PATCH", body: JSON.stringify({}) },
    );
    return data;
  }

  async toggleArchive(pathOrId: string): Promise<Page> {
    const { data } = await this.request<Page>(
      `/api/pages/${encodeURIComponent(pathOrId)}/archive`,
      { method: "PATCH", body: JSON.stringify({}) },
    );
    return data;
  }

  // ── Folders ───────────────────────────────────────────

  async listFolders(): Promise<string[]> {
    const { data } = await this.request<unknown>("/api/folders");
    return unwrapList<string>(data);
  }

  async createFolder(name: string): Promise<{ name: string }> {
    const { data } = await this.request<{ name: string }>("/api/folders", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    return data;
  }

  async renameFolder(name: string, newName: string): Promise<{ old_name: string; new_name: string }> {
    const { data } = await this.request<{ old_name: string; new_name: string }>(
      `/api/folders/${encodeURIComponent(name)}`,
      { method: "PATCH", body: JSON.stringify({ new_name: newName }) },
    );
    return data;
  }

  async deleteFolder(name: string, action: "move" | "delete" = "move", moveTo?: string): Promise<void> {
    const params = new URLSearchParams({ action });
    if (moveTo) params.set("move_to", moveTo);
    await this.request<void>(`/api/folders/${encodeURIComponent(name)}?${params}`, {
      method: "DELETE",
    });
  }

  // ── Generator ─────────────────────────────────────────

  async generatePassword(options?: {
    length?: number;
    uppercase?: boolean;
    lowercase?: boolean;
    digits?: boolean;
    symbols?: boolean;
  }): Promise<{ password: string }> {
    const opts = { length: 20, ...options };
    const { data } = await this.request<{ value: string }>("/api/generate/password", {
      method: "POST",
      body: JSON.stringify(opts),
    });
    return { password: data.value };
  }

  // ── Passkeys ──────────────────────────────────────────

  async passkeyRegister(rpId: string, body: PasskeyCreateRequest): Promise<RegistrationResult> {
    const { data } = await this.request<RegistrationResult>(
      `/api/passkeys/${encodeURIComponent(rpId)}/register`,
      { method: "POST", body: JSON.stringify(body) },
    );
    return data;
  }

  async passkeyAuthenticate(rpId: string, body: PasskeyGetRequest): Promise<AssertionResult> {
    const { data } = await this.request<AssertionResult>(
      `/api/passkeys/${encodeURIComponent(rpId)}/authenticate`,
      { method: "POST", body: JSON.stringify(body) },
    );
    return data;
  }

  async passkeyList(rpId: string): Promise<PasskeyCandidate[]> {
    const { data } = await this.request<{ items: PasskeyCandidate[] }>(
      `/api/passkeys?rp_id=${encodeURIComponent(rpId)}`,
    );
    return data.items ?? [];
  }

  // ── Login jobs ────────────────────────────────────────

  /**
   * Wait up to `waitSeconds` for a login job. The desktop drops its copy of
   * the credential on hand-over, so a job that is not acted on is gone.
   */
  async pollLoginJob(waitSeconds: number): Promise<LoginJob | null> {
    const { data } = await this.request<{ job: LoginJob | null }>(
      `/api/browser/jobs?wait=${Math.max(0, Math.min(25, Math.floor(waitSeconds)))}`,
    );
    return data.job ?? null;
  }

  async reportLoginJob(id: string, ok: boolean, message: string): Promise<void> {
    await this.request<void>(`/api/browser/jobs/${encodeURIComponent(id)}/result`, {
      method: "POST",
      body: JSON.stringify({ ok, message }),
    });
  }
}

/**
 * Build the local API base URL. The host is HARD-CODED to the IPv4 loopback
 * (127.0.0.1) — it is never derived from user/config input — so the bearer
 * token can only ever be transmitted to the local desktop app and never leaks
 * to a remote origin even if config is tampered with. Only the port is
 * configurable; it is clamped to a valid TCP port and falls back to the
 * default (9315) on anything out of range.
 */
export function buildLocalBaseUrl(port: number): string {
  const p = Number.isInteger(port) && port > 0 && port <= 65535 ? port : 9315;
  return `http://127.0.0.1:${p}`;
}

// ── Error parsing — handles both v2 JSON envelope and v1 plain-text bodies ──

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: ApiErrorCode,
    message: string,
    public details?: Record<string, unknown>,
    public etag?: string | null,
  ) {
    super(`API ${status} (${code}): ${message}`);
    this.name = "ApiError";
  }

  /** True for `412 PRECONDITION_FAILED` — caller should re-fetch and retry. */
  get isPreconditionFailed(): boolean {
    return this.code === "PRECONDITION_FAILED";
  }

  /** Best-effort current ETag returned by the server on a 412, for UI revert + refetch. */
  get currentEtag(): string | null {
    if (this.etag) return this.etag;
    const fromDetails = this.details?.["current_etag"];
    return typeof fromDetails === "string" ? fromDetails : null;
  }
}

async function parseError(status: number, body: string, etag: string | null): Promise<ApiError> {
  // Try the v2.0.0 JSON envelope first.
  try {
    const parsed = JSON.parse(body) as ApiErrorEnvelope;
    if (parsed && typeof parsed === "object" && parsed.error) {
      return new ApiError(
        status,
        parsed.error.code,
        parsed.error.message ?? body,
        parsed.error.details,
        etag,
      );
    }
  } catch {
    // Not JSON — fall through to legacy handling.
  }
  // 1.x desktops return plain text — synthesize a code from the status.
  return new ApiError(status, codeFromStatus(status), body || "", undefined, etag);
}

function codeFromStatus(status: number): ApiErrorCode {
  switch (status) {
    case 400: return "BAD_REQUEST";
    case 401: return "UNAUTHORIZED";
    case 403: return "VAULT_LOCKED";
    case 404: return "NOT_FOUND";
    case 412: return "PRECONDITION_FAILED";
    case 503: return "NOT_READY";
    default: return "INTERNAL_ERROR";
  }
}

/**
 * Accept both v2.0.0 envelope `{items: [...]}` and v1.x bare arrays.
 * Returns an empty array for unknown shapes rather than throwing — the
 * client should still be usable when the server is older than expected.
 */
function unwrapList<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === "object" && "items" in data) {
    const items = (data as { items: unknown }).items;
    if (Array.isArray(items)) return items as T[];
  }
  return [];
}
