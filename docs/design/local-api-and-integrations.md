# Local API & Integrations — Design Document

**Feature:** Expose the Claspt vault to external tools via a local HTTP API, MCP server, CLI, and inbox watcher — all embedded in the desktop app, reusing the existing crypto engine, vault manager, and search index.

**Status:** Proposed
**Version:** 1.0
**Date:** 2026-03-02

---

## Table of Contents

1. [Motivation](#1-motivation)
2. [Architecture Overview](#2-architecture-overview)
3. [Local HTTP API](#3-local-http-api)
4. [MCP Server](#4-mcp-server)
5. [CLI Tool](#5-cli-tool)
6. [Inbox Watcher](#6-inbox-watcher)
7. [Settings UI](#7-settings-ui)
8. [Security Model](#8-security-model)
9. [Implementation Plan](#9-implementation-plan)
10. [Requirements Traceability](#10-requirements-traceability)

---

## 1. Motivation

Users store credentials, notes, and sensitive data in Claspt. Other tools — AI agents, scripts, automation workflows — need to read and write this data programmatically. Today the vault is only accessible through the GUI.

**Use cases:**

- An AI agent (Claude Code, Cursor, Windsurf) stores API keys or meeting notes into Claspt
- A shell script reads credentials from Claspt instead of `.env` files
- A Python automation creates daily journal pages
- A CI/CD pipeline queries Claspt for deployment secrets (via CLI)
- A Raycast/Alfred extension searches the vault
- A user drops markdown files into a folder and they appear in the vault

**Design constraint:** All four integration surfaces must be embedded in the desktop app to reuse the existing crypto engine, search index, vault lock state, and key handling — no code duplication, no separate daemons.

---

## 2. Architecture Overview

```
                    ┌──────────────────┐
                    │    Tauri App     │
                    │   (all logic)    │
                    │                  │
                    │  ┌────────────┐  │
                    │  │ Vault Mgr  │  │
                    │  │ Crypto Eng │  │
                    │  │ Search Idx │  │
                    │  │ Git Integ  │  │
                    │  └─────┬──────┘  │
                    │        │         │
                    │  ┌─────┴──────┐  │
                    │  │ Local HTTP │  │
                    │  │ :9315      │  │
                    │  └──┬──┬──┬───┘  │
                    │     │  │  │      │
                    │  ┌──┘  │  └──┐   │
                    │  │     │     │   │
                    │ MCP   CLI  HTTP  │
                    │ stdio  ↕   any   │
                    │  ↕    HTTP client │
                    │ HTTP              │
                    │                   │
                    │  ┌────────────┐   │
                    │  │  .inbox/   │   │
                    │  │  watcher   │   │
                    │  └────────────┘   │
                    └──────────────────┘
```

**Dependency chain:** Three of the four surfaces (MCP, CLI, external HTTP clients) are thin frontends over the same local HTTP API. The inbox watcher hooks directly into the vault manager since it's file-based.

**Key property:** Everything runs inside the Tauri process. When the vault locks, the API shuts down. When the app quits, all integration surfaces die. No orphan processes, no stale sockets.

---

## 3. Local HTTP API

The foundation. An axum listener bound to `127.0.0.1` inside the Tauri app that exposes vault operations as REST endpoints.

### 3.1 Lifecycle

| Event | Action |
|-------|--------|
| User enables "Local API" in Settings | Generate bearer token, persist to `config.json` |
| Vault unlock | Bind `127.0.0.1:{port}`, start accepting requests |
| Vault lock | Shut down listener, reject in-flight requests |
| App quit | Listener dies with process |
| Auto-lock timeout | Triggers vault lock → API shuts down |

### 3.2 Endpoints

All endpoints require `Authorization: Bearer <token>` header.

#### Pages

| Method | Path | Description | Tauri Command |
|--------|------|-------------|---------------|
| `GET` | `/api/pages` | List pages (optional `?folder=`, `?tag=`, `?archived=`) | `list_pages` |
| `GET` | `/api/pages/:id` | Read a page (content + frontmatter) | `read_page` |
| `POST` | `/api/pages` | Create a new page | `create_page` |
| `PUT` | `/api/pages/:id` | Update page content | `update_page` |
| `PATCH` | `/api/pages/:id` | Update metadata (title, folder, tags, pinned, archived) | `update_page_meta` |
| `DELETE` | `/api/pages/:id` | Move page to trash / delete | `delete_page` |

#### Search

| Method | Path | Description | Tauri Command |
|--------|------|-------------|---------------|
| `GET` | `/api/search?q=...` | Full-text search (tantivy) | `search_pages` |
| `GET` | `/api/search?q=...&scope=secrets` | Search secret labels only | `search_pages` |

#### Secrets

| Method | Path | Description | Tauri Command |
|--------|------|-------------|---------------|
| `GET` | `/api/pages/:id/secrets` | List secret blocks in a page (labels only, values encrypted) | `list_secrets` |
| `GET` | `/api/pages/:id/secrets/:label` | Read a decrypted secret value | `decrypt_secret` |
| `POST` | `/api/pages/:id/secrets` | Add a secret block (auto-encrypts) | `add_secret` |
| `PUT` | `/api/pages/:id/secrets/:label` | Update a secret value | `update_secret` |
| `DELETE` | `/api/pages/:id/secrets/:label` | Remove a secret block | `delete_secret` |

#### Folders

| Method | Path | Description | Tauri Command |
|--------|------|-------------|---------------|
| `GET` | `/api/folders` | List all folders | `list_folders` |
| `POST` | `/api/folders` | Create a folder | `create_folder` |

#### Vault

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/status` | Vault lock state, app version, uptime |

### 3.3 Request/Response Format

All JSON. Page content is returned as raw markdown string. Secret values are decrypted on read, encrypted on write — the API consumer never sees ciphertext.

```json
// POST /api/pages
{
  "title": "AWS Credentials",
  "folder": "credentials",
  "content": "## AWS Production\n\nRegion: us-east-1",
  "tags": ["aws", "production"]
}

// Response
{
  "id": "a1b2c3d4",
  "title": "AWS Credentials",
  "folder": "credentials",
  "created_at": "2026-03-02T10:30:00Z",
  "updated_at": "2026-03-02T10:30:00Z"
}
```

```json
// POST /api/pages/:id/secrets
{
  "label": "Access Key",
  "value": "AKIAIOSFODNN7EXAMPLE",
  "template": "api_key"
}

// Response
{
  "label": "Access Key",
  "encrypted": true
}
```

### 3.4 Error Responses

| Status | Meaning |
|--------|---------|
| `401` | Missing or invalid bearer token |
| `403` | Vault is locked |
| `404` | Page or secret not found |
| `422` | Invalid request body |
| `500` | Internal error |

### 3.5 Implementation Notes

- **Module:** `src-tauri/src/local_api.rs` (~300 lines)
- **Reuse:** Route handlers call the same functions that Tauri IPC commands use. No logic duplication.
- **Binding:** `127.0.0.1` only (not `0.0.0.0`). IPv4 loopback. Not exposed to LAN.
- **Port:** Default `9315` ("CLSP" on a phone keypad), user-configurable.
- **Concurrency:** Shares the app's `Arc<AppState>`. Read-heavy workload; existing `RwLock` on vault state is sufficient.
- **Shutdown:** The axum server task is cancelled via a `tokio::sync::watch` channel when the vault locks.

---

## 4. MCP Server

[Model Context Protocol](https://modelcontextprotocol.io/) — the standard for AI tools to interact with local data sources. Claude Desktop, Cursor, Windsurf, Continue, and others support it natively.

### 4.1 How It Works

The Tauri binary accepts a `--mcp` flag. When launched with this flag, it:

1. Skips the GUI
2. Reads the API token from `.securenotes/config.json`
3. Speaks MCP (JSON-RPC over stdio) — reading from stdin, writing to stdout
4. Translates each MCP tool call into an HTTP request to `localhost:9315`
5. Returns the response via stdout

The MCP process is **stateless** — all logic lives in the running Tauri app.

### 4.2 Configuration

```json
// Claude Desktop — claude_desktop_config.json
{
  "mcpServers": {
    "claspt": {
      "command": "/Applications/Claspt.app/Contents/MacOS/claspt",
      "args": ["--mcp"]
    }
  }
}
```

```json
// Cursor / Windsurf / Continue — similar format
{
  "claspt": {
    "command": "claspt",
    "args": ["--mcp"]
  }
}
```

### 4.3 MCP Tools Exposed

| Tool | Description | Parameters |
|------|-------------|------------|
| `search` | Full-text search across all pages | `query` (string), `scope?` ("all" \| "secrets") |
| `read_page` | Read a page's full content | `id` or `title` (string) |
| `list_pages` | List pages, optionally filtered | `folder?`, `tag?`, `limit?` |
| `create_page` | Create a new page | `title`, `folder?`, `content`, `tags?` |
| `update_page` | Update a page's content | `id`, `content` |
| `add_secret` | Add an encrypted secret block to a page | `page_id`, `label`, `value`, `template?` |
| `read_secret` | Read a decrypted secret value | `page_id`, `label` |
| `list_folders` | List all vault folders | — |
| `vault_status` | Check if vault is unlocked | — |

### 4.4 MCP Resources (read-only browsing)

| URI Pattern | Description |
|-------------|-------------|
| `claspt://pages` | List of all pages |
| `claspt://pages/{id}` | A single page's content |
| `claspt://folders` | Folder tree |

### 4.5 Example AI Interactions

**Storing credentials:**
> "Save this AWS key to my Claspt vault under credentials"
> → AI calls `create_page` + `add_secret`

**Looking up secrets:**
> "What's the API key for the production database?"
> → AI calls `search("production database")` → `read_secret(page_id, "API Key")`

**Organizing notes:**
> "Move all pages tagged 'meeting' into the 'archive' folder"
> → AI calls `list_pages(tag="meeting")` → loops `update_page_meta(folder="archive")`

**Daily journaling:**
> "Create today's journal entry with these meeting notes"
> → AI calls `create_page(title="2026-03-02 Journal", folder="journal", content=...)`

### 4.6 Implementation Notes

- **Module:** `src-tauri/src/mcp.rs` (~200 lines)
- **Protocol:** JSON-RPC 2.0 over stdio, per MCP spec
- **Dependencies:** `serde_json` (already present), HTTP client for localhost calls (`reqwest` or raw `hyper`)
- **Error handling:** If the app isn't running or vault is locked, return MCP error with human-readable message: "Claspt vault is locked. Unlock it in the app to continue."

---

## 5. CLI Tool

A command-line interface using the same binary with subcommands.

### 5.1 How It Works

```bash
claspt <subcommand> [options]
```

Each subcommand reads the API token from `.securenotes/config.json` and makes an HTTP call to `localhost:9315`. Outputs to stdout (JSON by default, `--format text` for human-readable).

### 5.2 Commands

```bash
# Search
claspt search "aws credentials"
claspt search "api key" --scope secrets
claspt search "meeting" --folder journal --limit 10

# Read
claspt read <page-id>
claspt read --title "Server Setup"
claspt read <page-id> --secret "API Key"        # decrypt + print a secret value

# Create
claspt create --title "New Page" --folder credentials --content "..."
claspt create --title "Imported" --folder inbox < notes.md    # pipe content from stdin

# Update
claspt update <page-id> --content "new content"
claspt update <page-id> --append "## Added section"           # append to existing
claspt update <page-id> --tags "aws,production"                # update metadata
claspt update <page-id> --folder "archive"                     # move to folder

# Secrets
claspt add-secret <page-id> --label "Token" --value "sk-..."
claspt add-secret <page-id> --label "Token" --value -          # read value from stdin (no shell history)

# List / Browse
claspt list                              # all pages
claspt list --folder credentials         # pages in folder
claspt folders                           # list folders

# Status
claspt status                            # vault lock state, version, API port

# Memory import (3.3.25)
claspt memory import --from mem0 export.json --dry-run
claspt memory import --from claude-md ./CLAUDE.md
claspt memory import --from cursor-rules ./.cursor/rules

# Headless server (3.3.23)
CLASPT_SERVE_PASSPHRASE=... claspt serve init-key --out /etc/claspt/serve.key < <(read -rs p; echo "$p")
CLASPT_SERVE_PASSPHRASE=... claspt serve run --vault /srv/vault --key-file /etc/claspt/serve.key --policy /etc/claspt/policy.toml --ssh-agent

# SSH agent (3.3.21)
eval "$(claspt ssh env)"                 # point ssh/git at the vault's agent
claspt ssh list                          # keys the agent offers, and where they live
claspt ssh add ~/.ssh/id_ed25519 --label "Laptop key"   # store a key for the agent (tagged ssh-key)

# Secrets without printing them (3.3.19)
claspt run -f .env -- npm start          # .env values may be claspt://secret/<page>?block=<label>#<field>
claspt run -e TOKEN=claspt://secret/ai/github.md#token -- gh auth status
claspt inject config.tmpl --out config.toml   # fill references, write owner-only
claspt inject - < template.yaml          # from stdin to stdout
```

### 5.3 Output Formats

```bash
# Default: JSON (for piping to jq, scripts, etc.)
claspt search "aws" | jq '.[0].title'

# Human-readable
claspt search "aws" --format text

# Quiet (IDs only — for scripting)
claspt list --folder credentials --quiet | xargs -I{} claspt read {}
```

### 5.4 Unix Composability

```bash
# Pipe content into a new page
cat meeting-notes.md | claspt create --title "Q1 Review" --folder meetings

# Read a secret and use it in a command
export AWS_KEY=$(claspt read "AWS Prod" --secret "Access Key" --raw)

# Bulk tag update
claspt list --folder inbox --quiet | xargs -I{} claspt update {} --folder archive

# Search and read
claspt search "database password" --quiet | head -1 | xargs claspt read
```

### 5.5 Implementation Notes

- **Module:** `src-tauri/src/cli.rs` (~150 lines)
- **Parser:** `clap` (already a Tauri dependency)
- **Entry point:** Detect CLI subcommands in `main.rs` before Tauri builder runs. If present, run CLI mode and exit.
- **Token discovery:** Read from `~/.config/claspt/api.token` or `~/.securenotes/config.json`, or `CLASPT_TOKEN` env var.

---

## 6. Inbox Watcher

A watched folder where external tools drop markdown files for automatic ingestion.

### 6.1 How It Works

```
~/Claspt/.inbox/                    ← watched folder (created on enable)
  2026-03-02-meeting-notes.md       ← drop a file here
  quick-note.md                     ← any .md file
```

When a `.md` file appears in `.inbox/`:

1. **Parse frontmatter** — if YAML frontmatter exists, extract `folder`, `tags`, `title`
2. **Assign defaults** — if no frontmatter: title from filename, folder from settings default (e.g., `inbox/`), no tags
3. **Generate metadata** — add `id`, `created_at`, `updated_at`, filename slug
4. **Move into vault** — rename file to vault naming convention (`YYYY-MM-DD-HHMMSS-title-slug.md`), place in target folder
5. **Index** — add to tantivy search index
6. **Git commit** — auto-commit via existing git integration
7. **Delete original** — remove from `.inbox/`
8. **Notify UI** — emit event so sidebar refreshes

### 6.2 Frontmatter Support

Files dropped with frontmatter get routed intelligently:

```yaml
---
title: AWS Production Credentials
folder: credentials
tags: [aws, production]
---

Region: us-east-1
Account: 123456789
```

Files without frontmatter get default handling:

```markdown
Just some quick notes from the standup meeting.
Action items: deploy by Friday.
```
→ Title: "quick-note" (from filename), Folder: `inbox/`, Tags: none

### 6.3 Secret Blocks

If a dropped file contains `:::secret[Label]...:::` blocks, the watcher encrypts the values automatically using the vault's master key before writing to the final location.

```markdown
---
title: Database Credentials
folder: credentials
---

## Production DB

:::secret[Password]
s3cur3_p@ssw0rd
:::
```

→ The `s3cur3_p@ssw0rd` is encrypted to `enc:v1:<base64>` on ingest.

### 6.4 Batch Handling

Multiple files dropped at once are processed sequentially. A 1-second debounce groups rapid drops into a single git commit.

### 6.5 Error Handling

| Scenario | Behavior |
|----------|----------|
| Invalid markdown / binary file | Move to `.inbox/.errors/` with error log |
| Duplicate title in same folder | Append `-2`, `-3` suffix |
| Vault locked when file dropped | Queue until vault unlocks |
| Disk full | Leave file in `.inbox/`, log error, show notification |

### 6.6 Implementation Notes

- **Module:** Extend existing `src-tauri/src/watcher.rs` (~100 lines added)
- **Dependency:** `notify` crate (already used for file watching)
- **No HTTP involved** — this hooks directly into the vault manager
- **Queue:** Files dropped while vault is locked are held in a `VecDeque` and processed on unlock

---

## 7. Settings UI

A new section in the existing Settings panel (`src/components/SettingsPanel.tsx`):

### 7.1 Local API Section

```
━━━ Integrations ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Local API
  [x] Enable local API server
  Port: [9315]
  API Token: [••••••••••••••••]  [👁] [Regenerate] [Copy]
  Status: ● Running (localhost:9315)

MCP Server
  Configure your AI tool with this command:
  ┌──────────────────────────────────────────────────┐
  │ /Applications/Claspt.app/.../claspt --mcp        │ [Copy]
  └──────────────────────────────────────────────────┘
  Supported: Claude Desktop, Cursor, Windsurf, Continue

Inbox Folder
  [x] Enable inbox watcher
  Default folder for dropped files: [inbox       ▾]
  Path: ~/Claspt/.inbox/  [Open Folder]
```

### 7.2 Config Persistence

Settings stored in `.securenotes/config.json`:

```json
{
  "local_api": {
    "enabled": true,
    "port": 9315,
    "token": "clsp_a1b2c3d4e5f6..."
  },
  "inbox": {
    "enabled": true,
    "default_folder": "inbox"
  }
}
```

Token format: `clsp_` prefix + 32 random hex chars (generated via `ring` CSPRNG).

---

## 8. Security Model

### 8.1 Threat Surface

| Surface | Risk | Mitigation |
|---------|------|-----------|
| HTTP API accessible from LAN | Other devices on network could query vault | **Bind to 127.0.0.1 only** — not 0.0.0.0, not [::]. Loopback only. |
| Token stolen from config.json | Full vault read/write access | Token file permissions `0o600`. Token regeneration in UI. Config file never synced. |
| Process on same machine reads token | Malware could extract token | Same threat as any local keychain. Process-level isolation is OS responsibility. |
| API stays open while user is away | Unattended vault access | API shuts down on vault lock. Auto-lock timeout applies. |
| Secret values returned in plaintext over HTTP | In-memory exposure | Localhost only (no network hop). Response not cached. Values are NOT zeroized after serialization — see ADR 0002. |
| MCP tool reads secrets without user awareness | AI agent silently exfiltrates | MCP tool descriptions include clear labels. Consider optional per-request approval for secret reads. |
| Inbox file contains malicious frontmatter | Path traversal via `folder` field | Reuse existing `safe_join` / `validateFolderName` path validation |

### 8.2 Security Properties Inherited from App

All integration surfaces inherit these properties automatically because they run inside the Tauri process:

- **Vault lock state** — API is unavailable when locked
- **Auto-lock timeout** — kills API on idle
- **Memory zeroing** — `Zeroizing<T>` on all key material
- **Brute force protection** — token is long random (not password-based)
- **Git auto-commit** — all changes via API are version-tracked
- **Tantivy indexing** — API-created pages are immediately searchable
- **Secret encryption** — values encrypted via the same AES-256-GCM engine

### 8.3 Token Security

- Generated using `ring::rand::SystemRandom` (CSPRNG)
- 32 bytes hex = 256 bits of entropy
- Prefixed with `clsp_` for easy identification in leaked credential scans
- Stored in `.securenotes/config.json` (permissions `0o600`, never synced)
- Regeneratable from Settings UI (invalidates all existing integrations)
- Not derived from master password — compromise of token doesn't compromise vault encryption

---

## 9. Implementation Plan

### 9.1 Module Breakdown

| Module | File | Estimated Size | Dependencies |
|--------|------|---------------|-------------|
| Local HTTP API | `src-tauri/src/local_api.rs` | ~300 lines | `axum` (already in workspace), existing command handlers |
| MCP Server | `src-tauri/src/mcp.rs` | ~200 lines | `serde_json`, HTTP client for localhost |
| CLI | `src-tauri/src/cli.rs` | ~150 lines | `clap` (already a dependency) |
| Inbox Watcher | `src-tauri/src/watcher.rs` (extend) | ~100 lines added | `notify` (already used) |
| Settings UI | `src/components/SettingsPanel.tsx` (extend) | ~80 lines added | Existing settings infrastructure |
| **Total** | | **~830 lines** | |

### 9.2 Build Sequence

| Step | Task | Depends On |
|------|------|-----------|
| 1 | Local HTTP API module + settings toggle | — |
| 2 | Token generation + auth middleware | Step 1 |
| 3 | Page CRUD routes (reuse existing handlers) | Step 2 |
| 4 | Secret routes (encrypt/decrypt) | Step 3 |
| 5 | Search route | Step 3 |
| 6 | Vault lock/unlock lifecycle (start/stop listener) | Step 1 |
| 7 | CLI subcommands (`clap` integration) | Step 3 |
| 8 | MCP stdio adapter | Step 3 |
| 9 | Inbox watcher | — (parallel) |
| 10 | Settings UI section | Step 1 |
| 11 | Integration tests | Steps 1–10 |

### 9.3 Testing Strategy

- **Unit tests:** Token generation, auth middleware, request parsing
- **Integration tests:** Start local API in test harness, make HTTP calls, verify vault mutations
- **MCP tests:** Pipe JSON-RPC messages via stdin, verify stdout responses
- **CLI tests:** Run subcommands against a test vault, verify output
- **Inbox tests:** Drop files into `.inbox/`, verify they appear in vault with correct metadata

---

## 10. Requirements Traceability

| Requirement | Implementation |
|-------------|---------------|
| AI tools can read/write vault pages | MCP server + HTTP API |
| AI tools can store/retrieve encrypted secrets | HTTP secret endpoints, MCP `add_secret`/`read_secret` tools |
| Shell scripts can query credentials | CLI tool with JSON output |
| Any HTTP-capable tool can integrate | Local REST API with bearer auth |
| Files dropped into a folder auto-ingest | Inbox watcher with frontmatter parsing |
| No code duplication with existing app | All surfaces reuse Tauri command handlers |
| Secret values never stored plaintext | Existing AES-256-GCM engine handles encrypt/decrypt |
| API unavailable when vault is locked | Listener starts on unlock, stops on lock |
| No orphan processes | Everything runs inside Tauri process |
| User controls what's exposed | Settings toggle, per-feature enable/disable |
| Changes are version-tracked | Existing git auto-commit covers API-made changes |
| Created content is immediately searchable | Existing tantivy indexing pipeline |
