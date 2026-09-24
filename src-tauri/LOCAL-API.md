# Claspt Local API Reference

The Claspt desktop app exposes a local HTTP API on `127.0.0.1` for use by the browser extension, the bundled MCP server, and external automation. Shapes are defined in `shared/src/types.ts` so all clients consume one contract.

- **Base URL:** `http://127.0.0.1:{port}` (default port `9315`, configurable in Settings → Integrations → Local API)
- **Authentication:** `Authorization: Bearer <token>` header on every request
- **Transport:** Plain HTTP over loopback (loopback is treated as a secure context per W3C spec; no TLS required)
- **Content type:** `application/json` for all request and response bodies (except `204 No Content`)
- **Versioning:** `GET /api/status` returns `version`, `vault_format_version`, and a `features` capability map. Clients should feature-detect via `features` rather than version-sniff.

---

## Architecture

Claspt has three API surfaces. Knowing which one you're calling matters because they have different consumers, transports, and concurrency models.

| Surface | Transport | Consumers | Treats vault as | Concurrency |
|---------|-----------|-----------|-----------------|-------------|
| **Desktop local API** (this doc) | Loopback HTTP | Browser extension, MCP, automation scripts on the same machine | Decrypted, structured (pages + secret blocks) | Last-write-wins or `If-Match` ETag |
| **Cloud sync API** (`/api/v2/...`) | TLS HTTPS to user's `server_url` | desktop sync engine | Opaque encrypted blobs | Sync versioning (manifest, ack) |

The cloud sync API doesn't expose CRUD primitives because each device edits its local vault and let the sync engine reconcile.

---

## Table of contents

- [Token scopes](#token-scopes)
- [Errors](#errors)
- [Identifiers](#identifiers)
- [Concurrency](#concurrency)
- [Endpoints](#endpoints)
  - [Status & versioning](#status--versioning)
  - [Pages](#pages)
  - [Secret blocks (granular operations)](#secret-blocks-granular-operations)
  - [Page lifecycle](#page-lifecycle)
  - [Search](#search)
  - [Folders](#folders)
  - [Password generator](#password-generator)
  - [Agent memory](#agent-memory)
- [Approval flow (Secrets scope)](#approval-flow-secrets-scope)
- [Changelog](#changelog)

---

## Token scopes

Tokens are issued by the desktop app at Settings → Integrations → Local API → **Manage Tokens**. Three scopes exist; pick the narrowest one that satisfies your use case.

| Prefix  | Scope     | Pages (read/write) | Secret values (read) | Secret values (write) | Approval popup | When to use |
|---------|-----------|:------------------:|:--------------------:|:---------------------:|:--------------:|-------------|
| `clsn_` | Notes     | Yes                | No (redacted)        | No (rejected)         | Never          | Note-taking integrations that should never see passwords |
| `clss_` | Secrets   | Yes                | Yes                  | Yes                   | Optional (per vault config) | Trusted password autofill (e.g. the browser extension) |
| `clsp_` | Legacy    | Yes                | Yes                  | Yes                   | Optional       | Backward-compatible alias for `clss_`. New tokens should use `clss_`. |

Tokens are 32 bytes of CSPRNG output, hex-encoded, with the scope prefix. Total length is `5 + 64 = 69` chars. Comparison is constant-time.

---

## Errors

All errors return a JSON body with this shape:

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Page not found: credentials/missing.md",
    "details": { "path": "credentials/missing.md" }
  }
}
```

| HTTP status | Error code | Meaning |
|-------------|------------|---------|
| `400` | `BAD_REQUEST` | Malformed body, invalid query, unknown enum value |
| `400` | `INVALID_PATH` | Path contains traversal (`..`) or absolute prefix |
| `401` | `UNAUTHORIZED` | Missing or invalid `Authorization` header |
| `403` | `VAULT_LOCKED` | Master key not loaded — unlock the desktop app |
| `403` | `SCOPE_INSUFFICIENT` | Token scope can't perform this operation (e.g. Notes scope writing secrets) |
| `403` | `APPROVAL_DENIED` | Secrets-scope request denied or timed out (`secret_access_mode: "approve"`) |
| `404` | `NOT_FOUND` | Page / folder / namespace doesn't exist |
| `404` | `BLOCK_NOT_FOUND` | Secret block label doesn't exist on this page |
| `409` | `LABEL_CONFLICT` | A different secret block on the same page already uses the requested new label |
| `412` | `PRECONDITION_FAILED` | `If-Match` header didn't match current ETag — client should re-fetch and retry |
| `500` | `INTERNAL_ERROR` | Encrypt/decrypt failure, filesystem error, search engine failure |
| `503` | `NOT_READY` | Search index not initialized yet |

The `details` object is optional and contains operation-specific debugging context.

---

## Identifiers

Pages can be referenced by either:

- **Path** — vault-relative file path (e.g. `credentials/2026-04-26-103000-github.md`). Stable until the page is moved or renamed.
- **ID** — UUID stored in the page's frontmatter (e.g. `01HXY3F8…`). Stable across moves, renames, and platform boundaries.

**Use ID when you need stability** (e.g. a credential reference stored in a third-party system). **Use path when convenience matters** (e.g. building a request URL from a search result).

Endpoints accept both via `{*path_or_id}`. The server detects the format:
- Looks like a UUID → treat as ID, look up the page
- Otherwise → treat as path

---

## Concurrency

Edit operations (`PUT`, `PATCH`, `DELETE`) accept an optional `If-Match` header carrying the value of the `ETag` returned by the most recent `GET` of that page.

The ETag is the page's `meta.updated_at` timestamp serialized as RFC 3339 milliseconds (e.g. `"2026-04-26T18:30:42.123Z"`). Using the timestamp instead of file-SHA means clients on different machines (after sync) can compare ETags without needing identical file bytes.

| Mode | Behavior |
|------|----------|
| **Without `If-Match`** | Last-write-wins. Suitable when you accept that you may overwrite concurrent changes. |
| **With `If-Match`** | Server returns `412 PRECONDITION_FAILED` if vault has changed. Client should re-fetch and retry — the **desktop always wins** on conflict. |

The browser extension uses `If-Match` for every PATCH/DELETE and reverts its optimistic UI update on `412`.

ETag is returned in:
- `ETag` response header on `GET /api/pages/{path_or_id}`
- `ETag` response header on every successful `PUT` / `PATCH` (so clients can chain edits without an extra fetch)

---

## Attribution

Clients should send `X-Claspt-Source: <product>/<context>` so vault auto-commit messages attribute the change. Examples:

- `X-Claspt-Source: extension/github.com` — browser extension acting on the github.com tab
- `X-Claspt-Source: mcp/claude-desktop` — MCP server acting on Claude Desktop's behalf
- `X-Claspt-Source: cli/script.sh` — automation script

The vault's git auto-commit message becomes:
`"Update: github.com - foo (via extension on github.com)"`

When the header is missing, the commit message uses just `"Update: github.com - foo"` (existing behavior).

---

## Endpoints

### Status & versioning

#### `GET /api/status`

Returns server health, app version, vault state, license tier, and a feature-detection capability map.

**Auth:** any valid token

**Response 200:**
```json
{
  "status": "ok",
  "version": "2.0.0",
  "vault_format_version": 1,
  "vault_unlocked": true,
  "plan": "Pro",
  "features": {
    "patch_secret": true,
    "delete_secret": true,
    "rename_secret": true,
    "move_page": true,
    "title_page": true,
    "if_match": true,
    "etag_timestamp": true,
    "approval_flow": true,
    "id_lookup": true,
    "json_errors": true,
    "source_attribution": true
  }
}
```

| Field | Type | Notes |
|-------|------|-------|
| `version` | string | App semver — bumps on app releases |
| `vault_format_version` | integer | Bumps on incompatible on-disk format changes; clients should refuse to write if higher than they understand |
| `vault_unlocked` | boolean | `false` means master key is not loaded |
| `plan` | string \| null | License tier: `"Free"`, `"Trial"`, `"Pro"`, `"Pro+"`, or `null` if expired |
| `features` | object | Capability map — feature-detect rather than version-compare |

---

### Pages

A "page" is a single `.md` file inside the vault. The file content includes any number of `:::secret[Label]…:::` blocks alongside regular markdown.

#### `GET /api/pages?folder={folder}&tag={tag}&limit={n}&cursor={c}`

List pages, optionally filtered, paginated.

**Query parameters:**
- `folder` (optional) — exact folder match
- `tag` (optional) — page must include this tag
- `limit` (optional, default 200, max 1000) — pagination size
- `cursor` (optional) — opaque cursor returned by the previous response's `next_cursor`

**Response 200:**
```json
{
  "items": [ /* PageSummary */ ],
  "next_cursor": "eyJv…" | null
}
```

`next_cursor: null` means no more pages.

---

#### `POST /api/pages`

Create a new page.

**Auth:** any valid token. **Notes scope cannot create pages with secret blocks.**

**Request body:**
```json
{
  "title": "github.com",
  "folder": "credentials",
  "content": "# github.com\n\n:::secret[github.com - foo]\nusername: foo\npassword: bar\n:::\n",
  "tags": ["work", "dev"]
}
```

**Response 201:** the created `Page` (with content). `ETag` header set.

---

#### `GET /api/pages/{*path_or_id}`

Read a page by path or ID. Notes scope returns the page with secret block values redacted.

**Response 200:** `Page` with `content` populated. `ETag` header set.

---

#### `PUT /api/pages/{*path_or_id}`

Replace the entire page content. **Destructive** — for granular edits use the `PATCH /api/pages/{*path_or_id}/secret` endpoints.

**Headers:**
- `If-Match: <etag>` (optional)

**Request body:**
```json
{ "content": "…full markdown body…" }
```

**Response 200:** updated `Page`. `ETag` header set to new value.

---

#### `DELETE /api/pages/{*path_or_id}`

Delete a page entirely.

**Headers:**
- `If-Match: <etag>` (optional)

**Response 204** on success.

---

### Secret blocks (granular operations)

These endpoints operate on a single `:::secret[Label]…:::` block within a page, leaving every other block and the surrounding markdown untouched. **All require Secrets scope.**

#### `PATCH /api/pages/{*path_or_id}/secret`

Merge fields into the secret block whose label matches `label`. Fields not in the request are preserved. Empty-string values delete the field. Optionally creates the block if it doesn't exist (`upsert: true`).

**Headers:**
- `If-Match: <etag>` (recommended)

**Request body:**
```json
{
  "label": "github.com - foo",
  "fields": {
    "username": "newuser",
    "password": "NewP@ssw0rd",
    "note": "Now uses MFA"
  },
  "delete_fields": ["legacy_field_to_remove"],
  "upsert": false
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `label` | string | yes | Exact secret block label to target |
| `fields` | object\<string, string\> | yes | Keys to merge. Empty value deletes the field. |
| `delete_fields` | string[] | no | Field names to remove (alternative to setting them empty) |
| `upsert` | boolean | no | If `true` and no block matches, append a new one. Default `false`. |

**Response 200:** updated `Page` with new content (decrypted). `ETag` header refreshed.

**Errors:** `403 SCOPE_INSUFFICIENT` (Notes), `404 BLOCK_NOT_FOUND` (no `upsert`), `412 PRECONDITION_FAILED`.

---

#### `DELETE /api/pages/{*path_or_id}/secret`

Remove a single secret block. If `delete_page_if_empty: true` and the block was the only meaningful content, delete the page entirely.

**Headers:** `If-Match: <etag>` (optional)

**Request body:**
```json
{ "label": "github.com - foo", "delete_page_if_empty": true }
```

**Response:**
- `200` with the updated `Page` if the page survives
- `204` (no body) if the page was deleted

---

#### `PATCH /api/pages/{*path_or_id}/secret/rename`

Change a secret block's label without altering its fields.

**Request body:**
```json
{ "old_label": "github.com - foo", "new_label": "github.com - foo (work)" }
```

**Response 200:** updated `Page`.

**Errors:** `404 BLOCK_NOT_FOUND`, `409 LABEL_CONFLICT` (target label already used on this page).

---

#### `GET /api/pages/{*path_or_id}/secret`

List all secret blocks in a page (Notes scope: labels only; Secrets scope: labels + decrypted fields).

**Response 200:**
```json
[
  { "label": "github.com - foo", "fields": { "username": "foo", "password": "bar", "note": "…" } }
]
```

Notes scope returns `fields: { redacted: true }` instead of values.

---

### Page lifecycle

#### `PATCH /api/pages/{*path_or_id}/move`

Move a page to a different folder. The page's path changes; clients holding the old path must use the new one returned in the response.

**Request body:**
```json
{ "folder": "archive/old" }
```

**Response 200:** updated `Page` with the new `path` and `meta.folder`.

**Errors:** `400 INVALID_PATH`, `404 NOT_FOUND`.

---

#### `PATCH /api/pages/{*path_or_id}/title`

Change a page's title (also updates filename slug if the title is structural).

**Request body:**
```json
{ "title": "github.com - work" }
```

**Response 200:** updated `Page` with the new `path` and `meta.title`.

---

#### `PATCH /api/pages/{*path_or_id}/tags`

Replace a page's tags.

**Request body:**
```json
{ "tags": ["work", "dev", "important"] }
```

**Response 200:** updated `Page`.

---

#### `PATCH /api/pages/{*path_or_id}/pin`

Toggle the page's pinned state.

**Request body:**
```json
{ "pinned": true }
```

**Response 200:** updated `Page`.

---

#### `PATCH /api/pages/{*path_or_id}/archive`

Toggle the page's archived state.

**Request body:**
```json
{ "archived": true }
```

**Response 200:** updated `Page`.

---

### Search

#### `GET /api/search?q={query}&scope={scope}&limit={n}`

Full-text search across the vault.

**Auth:** any valid token. Notes scope cannot use `scope=secrets`.

**Query parameters:**
- `q` (required)
- `scope` (optional) — `secrets` to limit to credentials only; default is full search
- `limit` (optional, default 50, max 500)

**Response 200:**
```json
{
  "items": [
    {
      "page_id": "01HXY…",
      "path": "credentials/github.md",
      "title": "github.com",
      "folder": "credentials",
      "snippet": "…matching context…",
      "score": 0.91,
      "secret_labels": ["github.com - foo"]
    }
  ]
}
```

Search results never include secret block values.

---

### Folders

#### `GET /api/folders`

List all folders in the vault.

**Response 200:**
```json
{ "items": ["credentials", "credentials/work", "general", "identities"] }
```

---

#### `POST /api/folders`

Create a new folder.

**Request body:**
```json
{ "name": "credentials/team" }
```

**Response 201:**
```json
{ "name": "credentials/team" }
```

---

#### `PATCH /api/folders/{*name}`

Rename a folder. All pages under it are moved.

**Request body:**
```json
{ "new_name": "credentials/team-renamed" }
```

**Response 200:**
```json
{ "old_name": "credentials/team", "new_name": "credentials/team-renamed", "moved_pages": 12 }
```

---

#### `DELETE /api/folders/{*name}?action={delete|move}&move_to={folder}`

Delete a folder. With `action=move`, pages in the folder are moved to `move_to`. With `action=delete`, pages are deleted with the folder.

**Response 204** on success.

---

### Password generator

The generator endpoints use only the desktop's local CSPRNG; no vault state is required.

#### `POST /api/generate/password`

```json
{
  "length": 20,
  "uppercase": true,
  "lowercase": true,
  "digits": true,
  "symbols": true,
  "exclude_ambiguous": false,
  "exclude_problematic": false,
  "max_symbols": 2
}
```

**Response 200:**
```json
{ "value": "Xk7$pBwR…", "strength": { "score": 4, "label": "Very Strong", "entropy": 130 } }
```

#### `POST /api/generate/passphrase`

```json
{ "word_count": 5, "separator": "-", "capitalize": true, "include_number": true }
```

#### `POST /api/generate/memorable`

```json
{ "word_count": 4, "separator": "-" }
```

#### `POST /api/generate/pin`

```json
{ "length": 6 }
```

#### `GET /api/generate/uuid`

Returns `{ "value": "<uuid>" }`.

#### `POST /api/generate/strength`

```json
{ "password": "MyP@ss" }
```

Returns the same `strength` object.

#### `POST /api/generate/bulk`

Generate up to 100 values of the same type in one request.

```json
{ "type": "password", "options": { "length": 20, "symbols": false }, "count": 50 }
```

`type`: one of `password`, `passphrase`, `memorable`, `pin`, `uuid`. `count` is clamped to `[1, 100]`.

**Response 200:** `{ "items": ["…", "…", …] }`.

---

### Agent memory

Lightweight key-value memory store for AI agents. Memories live in `.agent/{namespace}/`. Encrypted with the vault key, inherits vault lock state.

#### `GET /api/memory`

List namespaces. Response: `{ "items": ["ns1", "ns2"] }`.

#### `GET /api/memory/{namespace}?tag={tag}`

List memories. Response: `{ "items": [Page, Page, …] }`.

#### `PUT /api/memory/{namespace}`

Upsert a memory.

```json
{
  "title": "deploy-secrets-context",
  "content": "Last deploy used staging…",
  "tags": ["deploy"],
  "ttl_hours": 168,
  "custom_meta": { "agent_id": "deploy-bot-1" }
}
```

#### `POST /api/memory/{namespace}/bulk`

Bulk upsert.

#### `GET /api/memory/{namespace}/{*title}`

Read a memory. Notes scope: secret blocks redacted.

#### `DELETE /api/memory/{namespace}/{*title}`

Delete a memory.

#### `POST /api/memory/cleanup`

Delete TTL-expired memories.

---

## Approval flow (Secrets scope)

When the vault config sets `secret_access_mode: "approve"`, every Secrets-scope request triggers a Tauri `secret-access-request` event and waits up to **30 seconds** for the user to click Approve in the desktop app.

- Approval is per-session: once approved, the same token doesn't trigger another popup until the user locks the vault or the desktop is restarted.
- Timeout returns `403 APPROVAL_DENIED`.
- Notes-scope requests never trigger approval.

This is the model used by the bundled MCP server and by external "Secrets Only" tokens. The browser extension uses an `clss_` token without approval mode by default.

---

## Changelog

### 2.0.0 (planned, paired with browser extension 2.0.0)

**New endpoints:**
- `PATCH /api/pages/{*path_or_id}/secret` — non-destructive merge of fields into a named secret block
- `DELETE /api/pages/{*path_or_id}/secret` — remove a single secret block, optionally deleting the page if it becomes empty
- `PATCH /api/pages/{*path_or_id}/secret/rename` — change a secret block's label
- `GET /api/pages/{*path_or_id}/secret` — list secret blocks in a page
- `PATCH /api/pages/{*path_or_id}/move` — move a page to a different folder
- `PATCH /api/pages/{*path_or_id}/title` — change a page's title
- `PATCH /api/pages/{*path_or_id}/tags` — replace tags
- `PATCH /api/pages/{*path_or_id}/pin` — toggle pin
- `PATCH /api/pages/{*path_or_id}/archive` — toggle archive
- `PATCH /api/folders/{*name}` — rename a folder
- `DELETE /api/folders/{*name}` — delete a folder

**Standardization (breaking changes from 1.x):**
- All endpoints accept page **ID or path** (was: path only)
- All errors return JSON `{error: {code, message, details?}}` (was: plain text)
- All list endpoints return `{items, next_cursor?}` (was: bare array) — pagination now consistent
- `GET /api/status` extended with `vault_format_version` and `features` capability map
- `If-Match` / `ETag` support on page reads and writes
- ETag is `meta.updated_at` ISO timestamp (was: not present)
- `X-Claspt-Source` request header for attribution in auto-commit messages

- `shared/src/types.ts` extended with `SecretBlockPatch`, `SecretBlockDelete`, etc.

### 1.x

- Initial release with status, pages (PUT-only), search, folders, generator, memory endpoints
- Three token scopes (Notes, Secrets, Legacy) with constant-time comparison
- Optional Secrets-scope approval flow
- Plain-text error bodies, bare-array list responses

---

## Implementation references

| Layer | Path |
|-------|------|
| Desktop server | `src-tauri/src/local_api/server.rs` |
| Desktop routes | `src-tauri/src/local_api/routes.rs` |
| Desktop auth | `src-tauri/src/local_api/auth.rs` |
| Desktop secret-block parser | `src-tauri/src/pages/secret.rs` |
| Desktop page CRUD | `src-tauri/src/pages/crud.rs` |
| Desktop page model | `src-tauri/src/pages/model.rs` |
| Browser extension API client | `browser-extension/src/background/api-client.ts` |
| Shared types | `shared/src/types.ts` |
