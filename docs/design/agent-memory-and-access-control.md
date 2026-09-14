# Agent Memory Store & Two-Tier Access Control — Design Document

**Feature:** Persistent memory storage for AI agents, scoped API tokens separating notes from secrets, secret access approval flow, and system tray for background serving.

**Status:** Implemented
**Version:** 1.0
**Date:** 2026-03-04
**Claspt Version:** 2.5.0

---

## Table of Contents

1. [Motivation](#1-motivation)
2. [Two-Tier Token Architecture](#2-two-tier-token-architecture)
3. [Agent Memory Store](#3-agent-memory-store)
4. [Secret Access Approval](#4-secret-access-approval)
5. [MCP Token Auth](#5-mcp-token-auth)
6. [System Tray](#6-system-tray)
7. [Security Model](#7-security-model)
8. [API Reference](#8-api-reference)
9. [Data Model](#9-data-model)
10. [Implementation Details](#10-implementation-details)

---

## 1. Motivation

### Problem

Claspt v2.4 exposed vault access through a single bearer token (`clsp_*`) that granted all-or-nothing access — an AI agent that only needed to read notes could also decrypt every secret in the vault. This violated the principle of least privilege and created unnecessary risk.

Additionally, AI agents had no persistent memory layer. An agent could read and write vault pages, but had no structured way to store context, preferences, or conversation summaries across sessions. Agents had to repurpose general vault pages for memory, polluting the user's note hierarchy.

### Goals

1. **Least-privilege access** — agents that only need notes should never see secret values
2. **Structured agent memory** — a dedicated namespace for AI context that doesn't pollute the user's vault
3. **User control over secret access** — optional approval flow before agents can decrypt secrets
4. **Background serving** — vault stays accessible to agents even when the window is closed

### Non-Goals

- Multi-user access control (Claspt is single-user)
- Remote API access (localhost-only constraint preserved)
- Agent-to-agent communication (each agent has its own namespace)

---

## 2. Two-Tier Token Architecture

### Token Scopes

| Prefix | Scope | Access Level |
|--------|-------|-------------|
| `clsn_` | Notes | Pages, search, folders, generators. Secret block values replaced with `[REDACTED]`. Cannot create/update pages containing `:::secret` blocks. |
| `clss_` | Secrets | Full access including secret decryption. All API endpoints available. |
| `clsp_` | Legacy | Treated as Secrets scope for backward compatibility. |

### Token Format

All tokens are 69 characters: a 5-character prefix + 64 hex characters (256 bits of cryptographic randomness from `ring::rand::SystemRandom`).

```
clsn_a1b2c3d4e5f6...   (Notes token, 69 chars)
clss_f6e5d4c3b2a1...   (Secrets token, 69 chars)
clsp_1a2b3c4d5e6f...   (Legacy token, 69 chars)
```

### Scope Detection

Scope is determined by prefix matching at authentication time:

```rust
pub fn from_token(token: &str) -> Option<TokenScope> {
    if token.starts_with("clsn_") { Some(Notes) }
    else if token.starts_with("clss_") || token.starts_with("clsp_") { Some(Secrets) }
    else { None }
}
```

### Token Validation Flow

```
Request → Extract Bearer token
       → Detect scope from prefix
       → Constant-time compare against stored token for that scope
       → If Secrets scope: also check legacy token
       → If no match: try legacy token as fallback
       → Insert AuthInfo { scope } into request extensions
       → Route handler extracts scope via AuthInfo extractor
```

All comparisons use constant-time byte comparison (`constant_time_eq`) to prevent timing attacks.

### Token Migration

On vault unlock, if the vault has a legacy `local_api_token` (`clsp_*`) but no scoped tokens:

1. Generate a new `local_api_notes_token` (`clsn_*`)
2. Generate a new `local_api_secrets_token` (`clss_*`)
3. Preserve the legacy token for old CLI versions
4. Write all three to `config.json`

### Scope Enforcement in Routes

| Endpoint | Notes Scope | Secrets Scope |
|----------|-------------|--------------|
| `GET /api/pages/:path` | Secret values replaced with `[REDACTED]`. Full-body encrypted pages show `[REDACTED — full-body encrypted page]`. | Full decryption |
| `POST /api/pages` | Rejects if body contains `:::secret` blocks (403) | Allowed |
| `PUT /api/pages/:path` | Rejects if body contains `:::secret` blocks (403) | Allowed |
| `GET /api/search?scope=secrets` | Rejected (403) | Allowed |
| `GET /api/search` | Allowed (results may include pages with secrets, but secrets aren't in search results) | Allowed |
| All other endpoints | Allowed | Allowed |

### Config Fields

```json
{
  "local_api_token": "clsp_...",          // Legacy (preserved)
  "local_api_notes_token": "clsn_...",    // Notes-only access
  "local_api_secrets_token": "clss_...",  // Full access
  "secret_access_mode": "auto"            // "auto" or "approve"
}
```

---

## 3. Agent Memory Store

### Concept

Agent memories are stored as regular `.md` pages in dot-prefixed folders: `.agent/<namespace>/`. The dot prefix keeps them hidden from the normal sidebar and page listing. Each agent (or agent instance) gets its own namespace.

### Namespace Rules

- 1–64 characters
- Alphanumeric, hyphens, and underscores only
- Examples: `claude-code`, `cursor_main`, `my-automation`

### Storage Layout

```
~/Claspt/
  general/               — user pages (visible in sidebar)
  credentials/           — user pages (visible in sidebar)
  .agent/
    claude-code/          — memories for "claude-code" agent
      2026-03-04-143000-api-architecture.md
      2026-03-04-150000-debugging-notes.md
    cursor-main/          — memories for "cursor-main" agent
      2026-03-04-160000-project-context.md
  .securenotes/
    config.json
```

### Memory Page Structure

Memory pages are standard Claspt pages with additional frontmatter fields:

```yaml
---
id: "abc-123"
title: "API Architecture Decisions"
created_at: 2026-03-04T14:30:00Z
updated_at: 2026-03-04T15:00:00Z
folder: ".agent/claude-code"
tags: [architecture, api]
agent_ns: "claude-code"
memory_type: "persistent"
ttl_hours: 720
custom_meta:
  project: "claspt"
  importance: "high"
---

Content here...
```

### Memory Types

| Type | Behavior |
|------|----------|
| `persistent` | Default. Kept until explicitly deleted. |
| `session` | Application-level concept — agents can use this to mark session-scoped data. |
| `ephemeral` | Intended for short-lived data. Use `ttl_hours` for automatic cleanup. |

### TTL Cleanup

- An hourly background thread scans all `.agent/` pages
- Pages where `updated_at + ttl_hours < now` are deleted
- Thread uses the same `watchdog_active` atomic flag as the auto-lock timer for shutdown
- `ttl_hours: 0` or `ttl_hours: null` means permanent (no cleanup)
- Manual cleanup available via `POST /api/memory/cleanup`

### Upsert Semantics

The primary write operation is **upsert by title within namespace**:

1. Search `.agent/<namespace>/` for a page with matching title
2. If found → update content, tags, metadata
3. If not found → create new page in the namespace folder

This allows agents to use stable titles as keys (e.g., "Project Architecture", "User Preferences") without tracking file paths.

---

## 4. Secret Access Approval

### Flow

When `secret_access_mode` is set to `"approve"`:

```
Agent request with Secrets token
  → Auth middleware detects Secrets scope
  → Check config: secret_access_mode == "approve"?
  → Check: session already approved?
    → Yes: proceed
    → No: emit Tauri event "secret-access-request"
      → Frontend shows approval dialog
      → User clicks Approve/Deny (30s timeout)
        → Approve + "Remember for session": set session_approved = true
        → Approve (one-time): allow this request only
        → Deny or timeout: return 403 Forbidden
```

### ApprovalManager

```rust
pub struct ApprovalManager {
    pending: Mutex<HashMap<String, oneshot::Sender<bool>>>,
    session_approved: Mutex<bool>,
}
```

- Uses Tokio oneshot channels for async request/response
- Session approval persists until vault lock (cleared in `lock_vault`)
- Each pending request has a unique UUID

### Frontend Dialog

- Modal overlay with request details (tool name, page path)
- 30-second countdown timer with auto-deny
- "Remember for this session" checkbox
- Approve and Deny buttons

---

## 5. MCP Token Auth

### Dual-Mode Architecture

The MCP server now supports two authentication modes:

**Backend: HTTP API client**
```
CLASPT_API_TOKEN=clsn_... claspt --mcp
```
- Reads `CLASPT_API_TOKEN` env var
- Detects scope from token prefix
- Proxies MCP tool calls to the local HTTP API via `reqwest`
- Requires the desktop app to be running with API enabled

There is no second backend. Builds before 3.3.0 could unlock the vault
in-process from `CLASPT_PASSWORD` + `CLASPT_VAULT_DIR`; that handed the master
password to the agent process and bypassed the approval gate, and was removed.
A headless server with its own unlock and policy is `claspt serve` (3.3).

### Client tokens (3.3.7)

Every caller is a named client in `.securenotes/clients.json` (owner-only,
never synced): `{id, name, scope, token_hash, hint, created_at}`. The token
itself is never stored; the middleware hashes the presented bearer and
compares against every record in constant time. Minting happens in Settings
(shown once), through `claspt tokens create`, through `claspt mcp install`
(one client per installed MCP client) and through extension pairing (one
client per pairing). Revocation is per client and takes effect on the next
request. Pre-3.3.7 shared slots are migrated on unlock into hashed records and
the plaintext is deleted from the keychain and the config.

The CLI resolves its token as: `CLASPT_API_TOKEN`, else its own client token
kept in the OS keychain (minted once as "CLI on <host>"). A revoked CLI token
is not re-minted silently; `claspt tokens reset-cli` starts over.

### Access log (3.3.8)

`internal::access_log` records one JSON line per API request in
`.securenotes/internal/access/access-YYYY-MM.jsonl` (owner-only, excluded from
git and sync): timestamp, client id and name, scope, route-derived action,
URL-decoded path without query string, status, duration. Written by the auth
middleware after the handler returns, for authenticated and rejected requests
alike; a write failure is logged and never fails the request. Months beyond
`access_log_retention_months` (config, default 12, 1–120) are deleted when a
new month's file is created. Read by the `read_access_log` command (Settings
> Integrations > Activity) and `claspt log [--limit N] [--client ID]
[--month YYYY-MM]`.

### Conditional memory writes (3.3.9)

`PUT /api/memory/{ns}` and `POST /api/memory/{ns}/{title}/append` honour
`If-Match`, using the page's `updated_at` instant as the ETag, the same rule as
the page routes. The comparison is by instant, not string, because the `etag`
header spells it `+00:00` and the JSON `updated_at` field spells it `Z`, and
MCP clients only ever see the JSON. A conditional write against a missing page
is 412. `memory_read` returns the `etag` header and, over MCP, an `etag`
field in the result. `memory_upsert` and `memory_append` accept `if_match`;
`claspt memory upsert|append --if-match`.

### Standing approvals and the read limit (3.3.10)

Under `secret_access_mode = "approve"` the prompt offers three reaches: once,
this session (every client, every secret, until lock, the ADR 0001 grant), or
always for this client and this page (ADR 0003). "Always" is persisted in
`.securenotes/internal/approval-grants.json` keyed by `(client_id, target)`,
where the target is the page path for page and secret routes and the request
path otherwise (`approval::grant_target_for`). Listed and revocable in
Settings; revoking a client removes its grants.

`rate_limit::SecretReadLimiter` keeps a sliding one-minute window per client of
decrypting reads (`secret.read`, and `page.read`/`memory.read` under Secrets
scope). Past `secret_read_rate_limit_per_minute` (config, default 15, 1–600)
the request is 429 with `Retry-After`, logged like any other. The prompt shows
the client's count for the last minute. Windows clear on lock and on restart.

### Provenance and namespace policy (3.3.11)

Every memory write through the API stamps the page's frontmatter with
`written_by_client` and `written_by_name` (flat scalars, so the line-based
frontmatter reader on mobile carries them through; mobile now preserves every
frontmatter key it does not model). A client record may carry `namespaces`;
when non-empty, the memory routes refuse any other namespace (403), the
namespace listing is filtered to it, and `memory/cleanup` (which spans every
namespace) is refused. `claspt mcp install --project` mints a client limited
to the project's namespace and `global`; Settings and `claspt tokens create
--namespaces` take an explicit list.

### Memory model (3.3.12)

Memory pages carry `memory_kind` (`episodic` | `semantic` | `procedural`),
`valid_from`, `valid_until`, `superseded_by` and `verified_on` in frontmatter,
all flat scalars. Writes set them when given and keep them otherwise;
`memory_verify` stamps `verified_on` without re-sending content. A page is
`stale` when `valid_until` has passed or `superseded_by` is set; list and
read responses say so, and carry `read_count` and `last_read`, kept out of
band in `.securenotes/internal/memory-reads.json` so a read never bumps
`updated_at` (the ETag). Creating a page whose title shares at least half its
content words with an existing title returns a `warnings` entry. Per-kind
retention (`memory_<kind>_retention_days`, default 0 = keep) applies to pages
with no TTL of their own, on the hourly cleanup and `memory/cleanup`.

### Memory search (3.3.13)

`GET /api/memory/search?q=&namespaces=&limit=` (tool `memory_search`,
`claspt memory search`) runs the tantivy engine with folder scope
`ai/memory`, filters hits to the client's effective namespaces (requested ∩
allowed; empty allowance = all), and decorates each hit with kind, stale,
verified_on, writer and read statistics from the page on disk. When
`memory_rerank_model` is non-empty and `ollama_url` answers `/api/tags`
within 500 ms, the hits are re-ordered by cosine similarity of `/api/embed`
vectors (query plus title+snippet per hit, 5 s timeout); any failure keeps
full-text order. The response's `ranking` field says which was used.

### Bounded reads and compaction (3.3.14)

`GET /api/memory/:ns/:title?max_bytes=N&tail=true` returns at most `N`
bytes of content. The cut lands on a line boundary and never inside a
`:::secret` block: a block that does not fit is dropped whole, because a
half block is a broken fence, and a broken fence is how a value ends up
outside one on the next save. The response adds `truncated` and
`total_bytes` so the reader knows what it did not see. Read statistics
still count the read.

`POST /api/memory/:ns/:title/compact` with `{keep_sections}` (default 10,
minimum 1) moves every `## ` section after the newest `keep_sections` into
an archive page `"<title> archive YYYY-MM-DD"` (episodic, tagged
`memory`/`archive`) in the same namespace, appending if today's archive
already exists. Text before the first heading stays with the source page.
Headings inside code fences or secret blocks are content, not sections.
The source keeps its tags, TTL and custom metadata; the archive is a new
page with its own ETag. Secrets scope only, because the rewrite decrypts
and re-seals the page's secret blocks. Tools: `memory_compact`, `claspt
memory compact <title> [--keep N]`.

### The reviewed flag (3.3.15)

Every client write (`upsert`, `append`, `bulk`, `compact`, `bootstrap`)
stamps `reviewed: false` alongside `written_by_client`. Only the app can set
it to `true` (Tauri command `set_memory_reviewed`, inspector "Agent
review" section); there is no API route, so a client cannot review its own
writes. `needs_review` is `!reviewed` when the flag is set, and "has a
writer stamp" when it is not, so pages stamped before 3.3.15 count as
unreviewed and the owner's own pages never do.

An API read of an unreviewed page returns the content inside
`<claspt-unreviewed-memory written-by="...">` / `</claspt-unreviewed-memory>`
markers, a `reviewed: false` field and a warning telling the reader to treat
the content as data. The markers go on after windowing so they are always
whole. Marker lines are stripped from every write, so a client cannot store
a fence of its own and a read cannot be confused by one. `memory_list`
entries and `memory_search` hits carry `reviewed` too. The mobile
frontmatter parser carries the field through as an unknown line.

### Resources, prompts and the protocol revision (3.3.16)

`initialize` negotiates the protocol revision: the client's when it is one
of `2025-06-18`, `2025-03-26`, `2024-11-05`, else the newest. Tool results
carry `structuredContent` next to the text block. `ping` answers.

Resources: `claspt://memory-guide` and one `claspt://memory/<ns>/<title>`
per page in this project's namespace and `global`, listed through the same
API and token the tools use (so the list shows exactly what a tool could
read). `resources/read` goes through `call_namespace`, so a URI naming
another project's namespace is refused before any request is made; the
content's `_meta` carries `stale`, `reviewed` and `etag`. No subscriptions.

Prompts: `start-session` (optional `task`), `end-session` (required
`summary`), `review-memory`. Each is the memory convention written out for
the model with this project's namespace filled in.

### Memory dashboard (3.3.17)

Settings › Agent Memory lists every namespace and page with kind, last
writer, read count, and the unreviewed / stale / verified state, from
`agent_memory::overview` (Tauri command `memory_overview`; read statistics
come from the out-of-band store, so listing does not touch the pages). The
owner can mark pages reviewed from the table or open one in the editor.
`list_namespaces` is now shared by the dashboard and `GET /api/memory`.

### Secret references, `claspt run` and `claspt inject` (3.3.19)

A reference names a secret without holding it:
`claspt://secret/<page-path>?block=<label>#<field>` (`block` optional when
the page has one block; parts percent-encoded). `secret_ref.rs` is the one
parser: it finds references in text (ending at whitespace, quotes or
brackets), picks the field out of a page's blocks with errors that name
labels and fields but never values, and refuses a redacted (Notes-scope)
listing outright.

`claspt run [-e NAME=REF]... [-f FILE]... -- <cmd>` builds the child's
environment from the parent's, then each `--env-file` (dotenv rules, no
interpolation), then each `--env`, later entries overriding; every value
that is a reference is resolved through `GET /api/pages/{path}/secret`
(one request per page), so the read passes the same approval prompt, rate
limit and access log as any client. The child is started with only that
environment; the CLI's exit code is the child's. `claspt inject <file|->
[--out PATH]` substitutes every reference in a template, all or nothing,
and writes to stdout or to an owner-only file.

The API hands references back wherever it can: `references` per field on
secret-block listings and on the `store_secret` response, and
`reference_prefix` on `find_secrets` results (field names live inside the
encrypted body, so the index cannot complete them). The MCP `read_secret`
tool accepts `reference` and returns just that value; the tool
descriptions tell the agent to put references, not values, into files.

### Browser "log me in" (3.3.20, extension 2.5.0)

`POST /api/browser/login/{page}` (MCP `browser_login`) asks the paired
extension to log the user in with a credential from `page`. The request
needs Secrets scope and passes the approval prompt for that page like a
secret read (`browser.login` is in the decrypting actions; the target is
the page); the same rate limit and access log apply. The handler decrypts
the page, picks the block (explicit `label`, else the one block with a
`password` field, else the one whose own URL matches the requested host,
else 400 naming the labels), and queues a one-shot job holding the
credential in memory. The caller gets a job id and polls
`GET /api/browser/login/{job_id}`; it never receives the value.

The extension long-polls `GET /api/browser/jobs?wait=25` and reports with
`POST /api/browser/jobs/{id}/result`. Both routes require the client kind
`extension`, which only pairing sets (`ClientToken.kind`); a renamed or
hand-minted token cannot take jobs. The desktop drops the credential on
hand-over; a job nobody takes within 60 s is failed and its credential
dropped. Without a recent poll the login request is refused with 409, so
an agent learns at once that no browser is listening.

In the extension, `LoginJobRunner` keeps one poll open while connected and
unlocked (restarted from the health tick after a worker suspension) and
`executeLoginJob` opens the job's URL (else the credential's, else the
active tab), refuses excluded hosts, and sends the existing
`FILL_CREDENTIAL` message with `submit`, so the content script's HTTPS and
domain-match checks apply exactly as for a manual fill.

### SSH agent (3.3.21)

`ssh_agent/` serves the agent protocol (identities and sign; everything
else answers failure) on a Unix socket under the app data directory
(0600, directory 0700) or the named pipe `\\.\pipe\claspt-ssh-agent` on
Windows; `claspt ssh env` prints the `SSH_AUTH_SOCK` line. Keys are secret
blocks with a `private_key` field on pages tagged `ssh-key`; the tag is the
index, because field names sit inside the encrypted body. Block fields are
single lines, so the value is the OpenSSH key's base64 body without markers
or line breaks (a whole PEM squashed onto one line is accepted too);
`claspt ssh add <file>` stores it that way, with the `.pub` alongside and,
with `--passphrase-stdin`, the passphrase. `passphrase` unlocks an
encrypted key; `public_key` saves deriving the public half. Identities are
re-read from the vault on every request, so adding or removing a key needs
no restart. ssh-key 0.6.7's RSA conversion passes `p` twice, so the RSA
private key is rebuilt from its components here.

Each signature is a secret use: the rate limiter counts it under the fixed
client `ssh-agent`, the approval prompt fires when `secret_access_mode` is
"approve" (standing grants for `ssh-agent` on the page apply, ADR 0003),
and the access log records `ssh.sign` with the page as target and the
outcome. The private key is decrypted for that one signature and dropped.
RSA signatures honour the SHA-2 flags as OpenSSH's agent does. The prompt
and wait were moved into `approval::gate`, which the HTTP auth layer now
calls too, so both channels are one gate.

The agent starts with the local API on unlock and on launch when
`ssh_agent_enabled` is set; it keeps running across a UI lock and fails
closed after a key lock (no identities, every signature refused). Fixed in
passing: the local API auto-start still checked the pre-3.3.7 token slots
that migration empties, so a migrated vault stopped auto-starting.

### Rotation reminders (3.3.22)

`utilities::rotation` compares every stored password (fields in the same
list the health report uses, shared as `is_password_field`) with
`rotation_reminder_days` (default 180, 0 off, Settings > Security). Age is
the `generated` timestamp of the matching generated-password-history entry
when the value came from Claspt's generator, else the page's last save,
which can only overstate freshness. History pages and `url_match: never`
blocks are never candidates. `refresh_alerts` runs on every unlock and
keeps one `password_expiry` security alert per (page, label): raised once,
kept while dismissed, resolved by itself when the password is no longer
due. `GET /api/audit/rotation` (Secrets scope), MCP `rotation_due` and
`claspt audit --rotation` return the report without values.

### Headless: `claspt serve` (3.3.23)

The local API no longer reaches into Tauri. `local_api::services::Services`
is what the routes, the auth layer, the approval gate and the SSH agent
need from their host: the vault, search and git state, the approval
manager, rate limiter, browser jobs, SSH agent state and pairing window;
`pages_changed`, `prompt` and `spawn`; and `authorize`, the host's own say
on a request before any approval rule. `TauriServices` reads Tauri's
managed state and emits the prompt event; `HeadlessServices` owns the
state, answers `authorize` from a policy file and returns false from
`prompt`, which the gate treats as a refusal. `/api/status` reports
`mode`.

`claspt serve init-key --vault DIR --out FILE` reads the vault password
from stdin and writes the master key wrapped by the passphrase in
`CLASPT_SERVE_PASSPHRASE`, in the `vault.key` format, owner-only. The
vault password never goes to the server; the key file and passphrase do,
separately. `claspt serve run --key-file FILE [--policy FILE] [--port N]
[--ssh-agent]` unlocks from the file, checks the result against
`master_key_verify` so a key file from another vault is refused, reads the
passphrase out of the environment, opens the search index and git
batcher, and serves on 127.0.0.1 until Ctrl-C or SIGTERM, flushing the
last commit on the way out.

The policy (`local_api::policy`, TOML, `docs/examples/policy.toml`) is a
list of rules, each a client (name, id or `*`), action globs and target
globs; a request is allowed when one rule matches all three, else
refused with 403 and logged like any other refusal. Standing grants and
session approvals from the desktop do not apply headless: the policy is
the only source. Tokens, rate limits and the access log are the vault's
own, shared with the desktop app, so `claspt tokens create` on the
desktop mints a token the server honours.

### Passkeys (3.3.24, extension 2.6.0)

The desktop is a WebAuthn authenticator (`webauthn.rs`: a small canonical
CBOR encoder, authenticator data, "none" attestation, ES256 signatures
over `authData || SHA-256(clientDataJSON)`, and the origin check that a
page's host must be the relying party or a subdomain over HTTPS). Passkeys
live in `pages::passkeys`: the `passkeys` folder, one page per relying
party titled with its id and tagged `passkey`, one secret block per
credential holding the P-256 private key, user handle, credential id and
names, with `url_match: never` so the password picker and rotation
reminders leave them alone. Flags are UP|UV|BE|BS with a zero sign count,
the shape of a synced credential. Sync carries the pages; mobile preserves
the blocks as it does any secret.

`POST /api/passkeys/{rp}/register` and `/authenticate` take the request
the extension built from the page's options plus its origin; both are
decrypting actions, so the approval prompt and standing grants apply per
relying party (target `passkeys/<rp>`), the rate limit counts them and the
access log names them. `GET /api/passkeys?rp_id=` lists credentials for a
picker. A discoverable login with several accounts is refused with 409
until the caller names one.

In the extension, a document_start content script injects a page-world
provider that wraps `navigator.credentials.create` and `get`; public-key
requests cross to the bridge by `postMessage` with a per-request id, reach
the background as `PASSKEY_CREATE` / `PASSKEY_GET`, and come back as a
plain object with the shape and methods of `PublicKeyCredential`. When the
vault has no credential, the owner declines, the site asks for a
platform-only authenticator, or the request is conditional (autofill), the
call falls through to the browser's own implementation. Several accounts
bring up a closed-shadow-root picker. `shared/passkey-codec.ts` holds the
translations and is tested on its own.

### SDKs, adapters and memory import (3.3.25)

`sdks/python` (`claspt` on PyPI, standard library only) and
`sdks/typescript` (`@claspt/sdk` on npm, `fetch` only) wrap the local API:
status, memory (guide, list, read with a window, upsert with If-Match,
append, search, verify, compact), secrets (find, store, read by page or by
`claspt://secret` reference), and the audits. Both keep the API's refusals
as typed errors with the HTTP status, and both resolve a reference the way
`claspt run` does (one block, or the named one; redacted listings refused).
`claspt.tools.tool_specs` / `tools()` is one definition of the six
agent-facing tools; the LangChain, OpenAI Agents SDK and CrewAI adapters
map it, importing their framework only when called. Tests run against a
loopback fake of the API. Publishing to PyPI and npm is the owner's step.

`claspt memory import --from mem0|letta|zep|claude-md|cursor-rules <path>`
(`memory_import.rs`) reads the three JSON exports with one tolerant
reader (a top-level array or the first array under the usual keys; text
under `memory` / `text` / `content` / `fact`; time under `created_at` and
friends, RFC 3339 or epoch), splits CLAUDE.md at `## ` headings into
procedural pages, and turns `.cursorrules` and `.mdc` rules into pages
named by their `description`. Exact duplicates are dropped, titles made
unique, the source kept in `custom_meta`, and the whole set goes through
the existing bulk upsert; `--dry-run` lists what would be written.

### Agent Namespace

Resolved by `agent_namespace::resolve()`, first hit wins:

1. `CLASPT_AGENT_NS` in the environment (explicit override)
2. A `.claspt` marker file found from the working directory upward, stopping
   before the home directory. Format: `key = value` lines, `#` comments; only
   `namespace` is read. Written by `claspt namespace init`, committed with the
   project so every clone, machine and sub-directory resolves the same name.
3. The sanitized name of the working directory (what every pre-3.3 vault uses,
   so it stays the default)
4. `default` when the working directory has no project identity

`bootstrap_project` returns `namespace.{namespace, source, marker_path}` so an
agent can tell a pinned namespace from a guessed one. `global` is reserved and
is refused as a marker value; a folder literally named `global` resolves to
`global-project`.

```bash
claude mcp add claspt \
  -e CLASPT_API_TOKEN=clsn_abc... \
  -- claspt --mcp
```

---

## 6. System Tray

### Menu Items

| Item | Action |
|------|--------|
| Open Claspt | Show and focus the main window |
| Lock Vault | Emit `vault-lock-requested` event → locks vault + stops API |
| API: Running/Stopped | Status indicator (disabled, not clickable) |
| Quit | Full application exit |

### Behavior

- Window close → hides window (app continues running in tray)
- API server continues serving while vault is unlocked
- Auto-lock timer still applies
- Vault lock from tray → clears API, clears approval session

---

## 7. Security Model

### Threat Model Additions

| Threat | Mitigation |
|--------|-----------|
| Overprivileged agent token | Two-tier scoping — Notes token cannot access secrets |
| Timing attack on token comparison | `constant_time_eq` for all token checks |
| Agent reads secrets without user awareness | Optional approval mode with timeout |
| Stale approval session | Session cleared on vault lock |
| Master password handed to the agent process | The in-process unlock mode was removed in 3.3.0; the MCP server only proxies to the local API with a scoped token |
| Same-named projects sharing memory, renamed folders losing it | Committed `.claspt` marker pins the namespace; folder name is only the fallback |
| Agent namespace traversal | Validation: alphanumeric + hyphens + underscores only, 1-64 chars |
| Memory path traversal | `safe_join()` canonicalization for all file operations |

### Secret Redaction

For Notes-scoped tokens, secrets are redacted using the existing `transform_secrets` infrastructure:

```rust
pub fn redact_secrets(content: &str) -> String {
    transform_secrets(content, |_| Ok("[REDACTED]".to_string()))
        .unwrap_or_else(|_| content.to_string())
}
```

This transforms each `:::secret[Label]...:::` block, replacing the value while preserving the label and fence structure. Full-body encrypted pages return `[REDACTED — full-body encrypted page]` instead of attempting partial redaction.

### Memory Encryption

Memory pages containing `:::secret` blocks are encrypted on write using the same `encrypt_secrets()` pipeline as regular pages. The scope check applies to memory routes — Notes-scoped tokens cannot create memories containing secret blocks.

---

## 8. API Reference

### Memory Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/memory` | List all namespaces |
| `PUT` | `/api/memory/:namespace` | Upsert a memory (by title in body) |
| `GET` | `/api/memory/:namespace` | List memories in namespace (?tag=filter) |
| `GET` | `/api/memory/:namespace/:title` | Read a specific memory (`?max_bytes=&tail=` for a window) |
| `POST` | `/api/memory/:namespace/:title/compact` | Move older `## ` sections into an archive page |
| `DELETE` | `/api/memory/:namespace/:title` | Delete a memory |
| `POST` | `/api/memory/:namespace/bulk` | Bulk upsert multiple memories |
| `POST` | `/api/memory/cleanup` | Trigger TTL cleanup |

### Upsert Request Body

```json
{
  "title": "API Architecture Decisions",
  "content": "# Architecture\n\nWe chose Axum for...",
  "tags": ["architecture", "api"],
  "ttl_hours": 720,
  "custom_meta": {
    "project": "claspt",
    "importance": "high"
  }
}
```

### Upsert Response

Returns the full page object:

```json
{
  "meta": {
    "id": "abc-123",
    "title": "API Architecture Decisions",
    "created_at": "2026-03-04T14:30:00Z",
    "updated_at": "2026-03-04T15:00:00Z",
    "folder": ".agent/claude-code",
    "tags": ["architecture", "api"],
    "agent_ns": "claude-code",
    "memory_type": "persistent",
    "ttl_hours": 720,
    "custom_meta": { "project": "claspt", "importance": "high" }
  },
  "content": "# Architecture\n\nWe chose Axum for...",
  "path": ".agent/claude-code/2026-03-04-143000-api-architecture-decisions.md"
}
```

### Bulk Upsert Request Body

```json
{
  "memories": [
    { "title": "Memory 1", "content": "...", "tags": ["a"] },
    { "title": "Memory 2", "content": "...", "ttl_hours": 24 }
  ]
}
```

### CLI Commands

```bash
# Upsert a memory
claspt memory upsert --ns claude-code "Project Context" --content "..."

# Upsert from stdin
echo "Architecture notes..." | claspt memory upsert --ns claude-code "Architecture"

# List memories
claspt memory list --ns claude-code
claspt memory list --ns claude-code --tag architecture

# Read a specific memory
claspt memory read --ns claude-code "Project Context"

# Delete a memory
claspt memory delete --ns claude-code "Old Notes"

# Keep the newest 10 sections of the log, archive the rest
claspt memory compact "session-log" --keep 10

# Trigger TTL cleanup
claspt memory cleanup
```

### MCP Tools

| Tool | Description |
|------|-------------|
| `memory_upsert` | Create/update a memory by title. Namespace from `CLASPT_AGENT_NS` env. |
| `memory_list` | List memories with optional tag filter. |
| `memory_read` | Read a memory by title; `max_bytes` / `tail` for a window. Unreviewed content comes inside data markers. |
| `memory_compact` | Move older sections of a page into a dated archive page. |
| `memory_delete` | Delete a memory by title. |
| `memory_bulk_upsert` | Batch create/update multiple memories. |

---

## 9. Data Model

### Extended PageMeta

Four new optional fields added to the `PageMeta` struct:

```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
pub agent_ns: Option<String>,

#[serde(default, skip_serializing_if = "Option::is_none")]
pub memory_type: Option<String>,

#[serde(default, skip_serializing_if = "Option::is_none")]
pub ttl_hours: Option<u64>,

#[serde(default, skip_serializing_if = "Option::is_none")]
pub custom_meta: Option<HashMap<String, String>>,
```

All fields use `serde(default)` + `skip_serializing_if` — zero impact on existing pages. Old pages deserialize with `None` for all four fields.

Later releases added, with the same serde treatment: `written_by_client`,
`written_by_name` (3.3.11); `memory_kind`, `valid_from`, `valid_until`,
`superseded_by`, `verified_on` (3.3.12); `reviewed` (3.3.15).

### VaultConfig Extensions

```rust
pub local_api_notes_token: Option<String>,
pub local_api_secrets_token: Option<String>,
pub secret_access_mode: Option<String>,  // "auto" | "approve"
```

---

## 10. Implementation Details

### Key Files

| File | Role |
|------|------|
| `src-tauri/src/local_api/auth.rs` | TokenScope, AuthInfo, scoped generation, multi-token require_auth |
| `src-tauri/src/local_api/server.rs` | Multi-token ApiContext, router with memory routes |
| `src-tauri/src/local_api/routes.rs` | Scope enforcement, memory route handlers |
| `src-tauri/src/local_api/approval.rs` | ApprovalManager with oneshot channels |
| `src-tauri/src/pages/agent_memory.rs` | Memory CRUD, namespace validation, TTL cleanup |
| `src-tauri/src/pages/secret.rs` | `redact_secrets()`, `has_secret_blocks()` |
| `src-tauri/src/vault/config.rs` | Token fields, migration, access mode validation |
| `src-tauri/src/mcp.rs` | Dual-mode auth (HTTP API vs direct vault) |
| `src-tauri/src/cli.rs` | Memory subcommand, token priority |
| `src/components/SecretApprovalDialog.tsx` | Approval popup |
| `src/components/settings/IntegrationsTab.tsx` | Two-tier token UI, access mode selector |

### Reused Infrastructure

- `secret::transform_secrets` → reused for `redact_secrets`
- `crud::safe_join` → path validation for agent memory
- `model::parse_page` / `serialize_page` → page I/O for agent memory
- `model::generate_filename` → filename generation
- `auth::constant_time_eq` → multi-token comparison
- `init::write_restricted` → atomic 0o600 config writes

### Test Coverage

- `TokenScope::from_token` — prefix detection tests
- `generate_scoped_token` — format validation
- `constant_time_eq` — correctness and length mismatch
- `redact_secrets` — replacement correctness, no-op for no secrets
- `has_secret_blocks` — detection tests
- `validate_agent_namespace` — valid and invalid inputs
- 264 total Rust tests passing
