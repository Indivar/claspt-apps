<p align="center">
  <img src="src-tauri/icons/icon.png" alt="Claspt" width="128" height="128" />
</p>

<h1 align="center">Claspt</h1>

<p align="center">
  <strong>Memory and encrypted credentials for AI agents, in a vault you own. Also a very good password manager.</strong>
</p>

<p align="center">
  <img alt="Version" src="https://img.shields.io/badge/version-3.3.25-blue" />
  <img alt="Licence" src="https://img.shields.io/badge/licence-PolyForm%20Shield%201.0.0-lightgrey" />
  <img alt="Platforms" src="https://img.shields.io/badge/desktop-macOS%20%7C%20Windows%20%7C%20Linux-green" />
  <img alt="Encryption" src="https://img.shields.io/badge/encryption-AES--256--GCM-orange" />
</p>

---

Claspt's source is published under the PolyForm Shield licence so anyone can
read it, verify the security claims, and report problems. It is
**source-available, not open source**: you may study, build and audit it, but
not ship a competing product from it. See [LICENSE](LICENSE),
[SECURITY.md](SECURITY.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## What is Claspt?

Claspt is a local vault: markdown notes with encrypted secret blocks, stored as
portable `.md` files you own. On top of that it is a memory store and a
credential store for AI agents, with the controls a person needs to let an agent
near either:

- **Memory for agents.** Per-project namespaces, memory kinds (episodic,
  semantic, procedural), validity windows and staleness, full-text search across
  projects with optional local re-ranking, bounded reads and compaction, and a
  review step: what an agent writes is fenced as unreviewed until you have read it.
- **Credentials agents can use without seeing.** `claspt://secret` references
  resolved by `claspt run` and `claspt inject`, a browser "log me in" that fills
  the form for the agent, an SSH agent whose keys never leave the vault, passkeys
  stored in the vault, and rotation reminders that know when a password was made.
- **Named clients, approvals, a log.** Every agent, CLI and browser is a named
  client with its own revocable token and scope; secret reads pass an approval
  prompt (or a standing grant you chose), a rate limit, and an append-only access
  log. `claspt serve` runs the same API headless with a deny-by-default policy file.
- **Every way an agent talks.** MCP (tools, resources, prompts), a loopback HTTP
  API, a CLI, Python and TypeScript SDKs with LangChain, OpenAI Agents SDK and
  CrewAI adapters, and `claspt memory import` from mem0, Letta, Zep, CLAUDE.md
  and Cursor rules.

Notes and secrets live together. Write markdown as usual; when you need to keep
something sensitive, drop in a secret block:

```markdown
:::secret[HDFC Credit Card]
Card Number: 4111-xxxx-xxxx-1234
Name: John Doe
Expiry: 12/28
CVV: 987
:::
```

On save the block's body is replaced with an AES-256-GCM ciphertext. It renders
as a collapsible card: click to reveal, click a field to copy, hidden again after
30 seconds.

## What is in this repository

| Part | Where | Status |
|---|---|---|
| Desktop app (Tauri 2, Rust, React) | `src-tauri/`, `src/` | Source-available |
| Browser extension (Chrome family, Firefox) | `browser-extension/` | Source-available |
| Shared core crate (crypto, pages, git) | `crates/claspt-core/` | Source-available |
| Shared TypeScript types and helpers | `shared/` | Source-available |
| Python and TypeScript SDKs | `sdks/` | Source-available |
| Sync, sharing, licence system, mobile apps, server | not here | Proprietary; the desktop app builds without them |

## Features

### Vault

- **Encrypted secret blocks**: AES-256-GCM with Argon2id key derivation, unique nonce per block
- **Markdown-native**: notes are `.md` files with YAML frontmatter, fully portable
- **Instant search**: tantivy with BM25 ranking and field boosts
- **One-click copy**: sensitive fields hidden by default, clipboard cleared after 30 s
- **Secret templates**: credit card, website login, bank account, API key, SSH key, Wi-Fi, identity document, custom
- **Folders**: nested, with emoji icons and drag-to-move
- **Editor**: CodeMirror 6, split view, tables, maths, diagrams, callouts, 50+ languages
- **Git**: auto-commit on save with batching, version history, restore
- **Password generator**: password, passphrase, memorable, PIN, UUID, bulk; every generated password kept in the vault
- **Password health and rotation reminders**: weak, reused and old passwords, with real ages for generated ones

### For agents

- **MCP server**: `claspt --mcp`, protocol negotiation up to 2025-06-18, tools for memory and secrets, resources for every memory page, prompts for starting, ending and reviewing a session; `claspt mcp install <client>` writes the client config
- **Local HTTP API** on 127.0.0.1 with named client tokens, scopes, namespaces, approvals, rate limit and access log
- **CLI**: `claspt run`, `claspt inject`, `claspt ssh`, `claspt memory`, `claspt tokens`, `claspt audit`, `claspt serve`
- **SDKs**: `claspt` (PyPI) and `@claspt/sdk` (npm), framework adapters
- See [docs/quickstarts](docs/quickstarts) and the [MCP reference](docs/mcp/reference.md)

### Browser extension

- Autofill and save prompts, the generator, "log me in" for agents, passkeys, on Chrome, Edge, Brave and Firefox

## Security

| Protected (encrypted) | Not protected (plaintext) |
|---|---|
| Secret block content | Page titles and non-secret content |
| Master key on disk | File and folder names |
| Passkey and SSH private keys | Secret block labels |
| Key material in memory (zeroed on lock) | YAML frontmatter metadata |

**Threat model:** an attacker may read the vault directory (stolen laptop, cloud
backup, a compromised git remote) but does not have the master password. See
[docs/threat-model.md](docs/threat-model.md).

- AES-256-GCM with a unique 96-bit nonce per secret block
- Argon2id key derivation
- A 256-bit random master key wrapped by the password-derived key
- Brute-force protection with progressive delay
- Key material (master key, password-derived keys, recovery keys) wrapped in `Zeroizing<T>` and wiped on drop
- Decrypted secret *values* are not individually wiped; they are handed to the interface and live in process memory while the vault is unlocked. Hard lock wipes the master key, after which nothing further can be decrypted

## Vault structure

```
~/Claspt/
  general/                  default folder
  credentials/              suggested folder for secrets
  ai/memory/<namespace>/    agent memory, one namespace per project
  ai/secrets/               credentials agents stored
  passkeys/                 passkeys, one page per site
  .securenotes/
    config.json             vault configuration
    clients.json            named API clients (token hashes, never tokens)
    index/                  search index (local only)
    vault.key               encrypted master key (never synced)
    internal/access/        monthly access log
  .git/                     auto-initialised
```

## Development

### Prerequisites

- **Rust** — stable toolchain via [rustup](https://rustup.rs)
- **Node.js** 20+ and npm
- **Tauri CLI** — `cargo install tauri-cli`
- **System libraries** (Linux only):
  ```bash
  sudo apt install -y pkg-config libssl-dev libgtk-3-dev \
    libwebkit2gtk-4.1-dev libsoup-3.0-dev \
    libjavascriptcoregtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev
  ```
- **macOS:** Xcode Command Line Tools (`xcode-select --install`)

### Build & Run

```bash
npm install                        # Install JS dependencies
cargo tauri dev                    # Launch with hot reload
cargo tauri build                  # Production build
```

### Testing

```bash
# Rust (--lib is required; plain cargo test finds 0 tests)
cd src-tauri && cargo test --lib

# Frontend
npx vitest
```

### Linting & Formatting

```bash
cd src-tauri && cargo clippy       # Rust lint
cd src-tauri && cargo fmt --check  # Rust format check
npx eslint src/                    # TypeScript/React lint
npx prettier --check src/          # Frontend format check
```

### Versioning

**Every commit must bump the version** in `package.json` (the single source of truth). All other version references sync automatically via `npm run version:sync`, Vite defines, and `build.rs`.

## Architecture

```
┌──────────────────────────────────────────────────┐
│                  React Frontend                  │
│  Zustand stores │ CodeMirror 6 │ Tailwind CSS 4  │
├──────────────────────────────────────────────────┤
│                  Tauri IPC Bridge                │
├──────────────────────────────────────────────────┤
│                  Rust Backend                    │
│  Crypto (ring)  │ Vault │ Search (tantivy)       │
│  Git (git2)     │ Sync  │ License (Ed25519)      │
│  Local API      │ MCP   │ CLI (clap)             │
└──────────────────────────────────────────────────┘
```

| Layer | Key Technology |
|-------|----------------|
| Desktop runtime | Tauri 2.x (Rust) |
| Frontend | React 18 + TypeScript |
| Editor | CodeMirror 6 |
| Styling | Tailwind CSS 4 |
| Encryption | AES-256-GCM via `ring`, Argon2id KDF |
| Search | tantivy |
| State | Zustand |
| Git | `git2` |

## Project Structure

```
claspt/
├── src/                    # React frontend
│   ├── components/         #   UI components (editor, sidebar, panels, etc.)
│   ├── stores/             #   Zustand stores (vault, pages, search, ui)
│   ├── hooks/              #   Custom React hooks
│   └── lib/                #   Utilities, IPC bindings, types
├── src-tauri/              # Rust backend
│   └── src/
│       ├── commands/       #   Tauri IPC command handlers
│       ├── crypto/         #   AES-256-GCM, Argon2id, key management
│       ├── vault/          #   Directory structure, file CRUD, config
│       ├── pages/          #   Page parsing, secret blocks, frontmatter
│       ├── search/         #   tantivy indexing and queries
│       ├── git/            #   Auto-commit, version history
│       ├── local_api/      #   HTTP API server
│       ├── mcp.rs          #   MCP server (JSON-RPC over stdio)
│       ├── cli.rs          #   CLI subcommands
│       └── inbox.rs        #   Inbox file watcher
├── shared/                 # Shared types, constants, utilities
└── docs/                   # PRD, requirements, dev plan, specs
```

## Pricing

| Feature | Free | Pro |
|---------|:----:|:---:|
| Desktop app (macOS, Windows, Linux) | Yes | Yes |
| Unlimited pages, folders, secrets | Yes | Yes |
| Full-text search | Yes | Yes |
| Local Git auto-commit | Yes | Yes |
| Password generator | Yes | Yes |
| Cloud / remote sync | — | Yes |
| Self-hosted sync (WebDAV/SFTP) | — | Yes |
| Mobile app (iOS + Android) | — | Yes |
| Import from password managers | — | Yes |

## Reporting security issues

Report vulnerabilities as described in [SECURITY.md](SECURITY.md). The full
threat model, including what is deliberately not protected, is in
[docs/threat-model.md](docs/threat-model.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Contributions are accepted under a
[Contributor License Agreement](CLA.md), signed once on your first pull
request.

## License

Claspt is **source-available**, not open source. The desktop application,
browser extension, shared TypeScript package and the `claspt-core` crate are
published under the [PolyForm Shield License 1.0.0](LICENSE): you may read,
audit, build, run and contribute to them; you may not use them to build a
product that competes with Claspt. The mobile apps, the sync and licence
server, the sync client and the sharing feature are proprietary and are not
part of the published source. See [NOTICE](NOTICE).

Copyright 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
