# Claspt threat model

What Claspt protects, from whom, and what it deliberately does not. Written
for people deciding whether to trust it and for people changing it. Every
claim here is either enforced in code with a test, or marked as a known
limitation. If you find a statement that is neither, that is a bug in this
document; report it.

Last reviewed: 2026-09-09, against desktop 3.3.x.

## Assets, in order of value

1. The **master password** and the **master key** derived from it.
2. **Secret block values**: everything between `:::secret[...]` and `:::`.
3. **API tokens** (`clsn_`, `clss_`), which let a local process act on the
   vault while it is unlocked.
4. **Agent memory** under `ai/memory/`, which later sessions load as trusted
   context.
5. **Note text, titles, labels, folder names and tags.** Readable by design,
   see "Not protected".

## Trust boundaries

```
 browser page ──┐                                   ┌── sync server (Pro+)
                │ content script (isolated world)    │   sees ciphertext only
 extension ─────┤                                   │
                │  HTTP, loopback only, bearer token │
 MCP client ────┼──► local API ──► desktop app ──► vault folder on disk
 (Claude Code,  │   scope check     master key         markdown + enc:v1:
  Cursor, ...)  │   approval gate   in memory
                │
 CLI / SDK ─────┘
```

- **File permissions.** `vault.key`, the vault config, the internal store and
  every config file Claspt writes for an MCP client are owner-only on every
  platform: mode `0600`/`0700` on macOS and Linux, and on Windows a protected
  DACL with a single full-control entry for the current user and inheritance
  from the parent disabled (`crates/claspt-core/src/fs_perms.rs`, tested on a
  Windows runner in CI). Administrators can take ownership, as root can read
  a `0600` file; doing so is visible afterwards.
- **Disk.** Secret block values are AES-256-GCM ciphertext with a fresh 96-bit
  nonce per block per save (`enc:v1:`). The master key is on disk only inside
  `.securenotes/vault.key`, wrapped by an Argon2id-derived key (64 MB, 3
  passes, 4 lanes). `.securenotes/` is excluded from Git and sync by a managed
  `.gitignore` block that is reconciled on every vault open.
- **Local API.** Bound to `127.0.0.1`. Every route is behind token
  authentication. Each token belongs to a named client (an MCP client, the
  browser extension, the CLI, a script); the registry stores only the SHA-256
  of each token and compares in constant time, so a copy of it yields nothing
  usable. A token is shown once, when minted, can be revoked on its own, and
  can be limited to named memory namespaces, enforced by the memory routes.
  Two scopes: a Notes token can read and write pages and memory with secret
  bodies redacted and cannot create, edit or delete a secret block; a Secrets
  token can decrypt, subject to an optional approval prompt that names the
  client, shows how many secrets it read in the last minute, and times out
  closed (30 s to 403). A decision can stand for that client and that page
  until revoked in Settings (ADR 0003). Each client may decrypt at most a
  user-set number of secrets per minute (15 by default); past that it is told
  to wait and the attempt is logged. Locking the vault stops the API.
- **MCP.** The MCP server is a proxy to the local API with a token from its
  environment. It has no other way in: the mode that unlocked the vault from a
  password in the environment was removed in 3.3.0.
- **Extension.** Content scripts run in the isolated world; in-page UI uses
  closed shadow roots and acts only on trusted clicks; site matching uses the
  full Public Suffix List; a content script may edit credentials only for the
  site it is on.
- **Sync (Pro+).** The bundle carries ciphertext under a group key derived from
  the master password and never transmitted; no filenames, titles, folders,
  tags or labels reach the server. `vault.key` is never synced.
- **Writes.** Every write through the API is scanned for recognisable
  credentials outside a secret block and refused if one is found, for every
  token scope. `claspt audit` and the `audit_secrets` tool list anything that
  is on disk unencrypted.

## Attackers considered

| Attacker | Outcome |
|---|---|
| Reads the vault folder (stolen laptop, backup, Git remote) without the password | Gets note text, titles, labels, structure. Secret values and the master key are ciphertext. Offline brute force is bounded by Argon2id. |
| Compromises the sync server | Gets ciphertext and sizes. No names, no keys. |
| A malicious web page | Cannot reach the extension's storage or the API; the extension only acts on trusted clicks in isolated UI; site matching prevents a lookalike host from receiving another site's credentials. |
| An MCP client with a Notes token | Cannot obtain a secret value, structurally: secret bodies are ciphertext on disk and no Notes path holds the key. Can read and write notes and memory. |
| An MCP client with a Secrets token | Can decrypt, with approval if enabled. Can write memory that later sessions will trust, see "Memory poisoning". |
| A prompt-injected agent | Same as the two rows above, bounded by its token. Cannot write a recognisable key into plain note text (refused). |
| Another local user on the same machine | Cannot read `.securenotes/` or the API config files: owner-only on macOS, Linux and Windows. |
| Malware running as you on an unlocked machine | **Out of scope.** It can read the keychain and the vault the same way Claspt does. No local password manager defends against this. |

## Not protected, by design

- **Note text, titles, secret labels, folder names, tags, frontmatter.** Plain
  markdown, so notes stay portable, diffable and searchable. If you sync
  through a third-party backend, that text reaches the backend as it sits on
  disk.
- **Decrypted values in process memory.** Key material is wrapped in
  `Zeroizing` and wiped on lock. Decrypted secret *values* are not
  individually wiped after reveal; they live in process memory while the vault
  is unlocked. Hard lock wipes the master key, after which nothing further can
  be decrypted. Reasoning in `docs/adr/0002-decrypted-values-are-not-zeroized.md`.
  Claspt does not claim otherwise anywhere; if you see such a claim, it is an
  error.
- **The pairing window.** Connecting the extension opens `/api/pair` for 120
  seconds or one successful pair, whichever is sooner, during which any local
  process could obtain the token. Bounded, user-initiated, loopback-only, and
  the process it admits could already read the keychain.

## Known limitations, being worked on

- **Memory poisoning.** Every memory page now records which client last
  wrote it (`written_by_client`, `written_by_name` in its frontmatter), and
  the access log has the full history. What is still missing is a way for the
  user to mark a page as reviewed and for readers to be warned when it is not;
  that is phase 2. Until then, treat memory pages as data written by whoever
  held a token.
- **Extension token at rest.** The extension keeps its API token in
  `chrome.storage.local` so it can reconnect after a browser restart. It is
  only ever sent to `127.0.0.1` and is cleared from memory on lock, but it is
  long-lived. Short-lived, per-client tokens are planned alongside named
  client identities.
- **Access log.** Every API request is recorded: time, client, scope, the
  action derived from the route (`secret.read`, `memory.write`, …), the target
  path, status and duration. Failed authentications are recorded too, since a
  run of them is what token guessing looks like. Values and query strings are
  never logged. One file per month under `.securenotes/internal/access/`,
  owner-only, never synced, kept for a user-set number of months (12 by
  default). Visible in Settings and with `claspt log`.

## Things this document does not cover

Physical attacks on unlocked devices, side channels, and the security of the
operating system's keychain and biometric hardware, which Claspt relies on but
does not implement.
