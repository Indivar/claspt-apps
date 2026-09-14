# Deferred work & known limitations

This document records engineering work that was **intentionally deferred**, and
why. It exists so the decisions are transparent to contributors and reviewers —
none of these are surprises to discover later. **None are correctness bugs.**
They are either lower-value refactors that carry regression risk, or platform
work that requires on-device verification that CI can't provide.

## Deferred refactors (organizational / structural)

### God-file splits

`src-tauri/src/local_api/routes.rs` (~1300 lines), `src-tauri/src/mcp.rs`
(~1200 lines), and `src/components/SettingsPanel.tsx` (~1400 lines) are large and
would read better split into submodules / subcomponents.

Deferred because:

- The **MCP tool dispatch** and the **settings UI** cannot be exercised in
  headless CI. A pure code-motion split that compiles and passes the unit tests
  could still misroute a tool call or break a settings panel in a way only
  visible in the running app. The risk/reward of doing it blind is poor.
- The benefit is stylistic. Every file is now fully documented (module headers +
  per-item docs), which substantially mitigates the "hard to navigate" concern
  that motivates the split.

**Recommendation:** do this as a focused follow-up with the app running so the
MCP flows and settings panels can be exercised after each extraction.

### Command-error-type unification

Roughly 53 `#[tauri::command]`s return `Result<_, String>` while the rest return
typed, serializable error enums. Unifying them behind a single serializable
`CommandError` would give the frontend structured error codes everywhere instead
of stringly-typed messages in half the surface.

Deferred because it **changes the IPC error contract** the React frontend depends
on (how every command's failure is shaped and handled). That is a design
decision to weigh deliberately, not fold into a mechanical cleanup pass.

## Documented in-code limitations (security)

These are annotated at their source location; summarized here for visibility.

### Biometric keychain access control — `src-tauri/src/biometric/keystore.rs`

The master key is stored via the generic `keyring` crate at the platform default
(login-keychain-unlocked) accessibility, **not** bound to a biometric /
Secure-Enclave access-control policy. So a process running as the same user can
read it without Touch ID / Windows Hello firing; the biometric check is verified
in-process and is logically separate from key retrieval.

Hardening requires platform-specific code — a `SecAccessControl`
(`biometryCurrentSet` + `WhenUnlockedThisDeviceOnly`) item via
`security-framework` on macOS, and a Hello/DPAPI-gated store on Windows — and
**must be validated on real hardware**, since Touch ID / Hello prompts cannot be
exercised in CI. See the doc comment on `store_master_key`.

### Secret-block AEAD associated data — `crates/claspt-core/src/crypto/vault_key.rs`

Secret blocks are sealed with empty AAD, so the ciphertext is not
cryptographically bound to its label or page. An attacker with **filesystem write
access** could relocate an `enc:v1:` blob under a different label and it would
still decrypt (no plaintext disclosure — integrity/confusion only).

Binding `page_id + label` as AAD is the fix, but it changes the on-disk format
and must ship as a versioned `enc:v2:` with a legacy-decrypt fallback, otherwise
every existing secret — on desktop **and** the mobile app that shares this crate
— becomes undecryptable. Tracked as a deliberate, backward-compatible migration.
See the doc comment on `encrypt_block`.

## Deferred lint promotions

Three effects that **measure the DOM after render** — context-menu viewport
clamps (`EditorContextMenu`, `PreviewContextMenu`) and tooltip positioning
(`tour/use-tooltip-position.ts`) — carry a documented
`// eslint-disable-next-line react-hooks/set-state-in-effect` with the reason
inline. Each is a legitimate measure-after-render case with no render-derivable
alternative; a `useLayoutEffect` rewrite would change paint timing, so they were
left as annotated disables rather than a behavior-risky change.

## Minor UX follow-up

The per-secret three-dots menu and the ability to delete a page were reported as
awkward to reach after opening a page via search. A **page-delete button was
added to the page header** (visible in all modes, so an obsolete page found via
search can be deleted without hunting for it in the sidebar). Secret blocks
render the same way regardless of how a page was opened, so any remaining
per-secret-menu gap needs reproduction in the running app before it can be
addressed.

## Remaining low-priority items (non-Pro, recorded so nothing is silently pending)

These surfaced in the pre-open-source audit, are **not** in Pro/sync code, and
were judged low enough value/risk to leave for a follow-up. None is a
confidentiality bug or data-loss bug.

- **`decrypt_secrets` error policy differs across crates.** Desktop
  (`src-tauri/src/pages/secret.rs`) preserves the ciphertext of a single
  undecryptable block and renders the rest of the page; the shared core crate
  (`crates/claspt-core/src/pages/secret.rs`, used by mobile) hard-fails the whole
  page. Aligning them is a behaviour decision that also affects the mobile app,
  so it is deliberately left for a considered change rather than folded in here.
  A cross-crate guard test documents the divergence.
- **Folder rename/move via the local API leaves stale search-index paths.**
  `delete_folder` now purges the index (fixes the deleted-secret-label
  disclosure), but renaming/moving a folder over the API updates page paths
  without re-indexing, so old paths can linger as ghost hits until the next
  rebuild. Correctness only — no secret disclosure (the pages still exist).
- **MCP stdio loop is not hardened against non-UTF8 / unbounded lines.** A
  malformed stdin line can end the loop; line length is unbounded. Local-only
  transport, but worth hardening for robustness.
- **Unclosed `:::secret` fence at end of document.** A secret whose closing
  fence has not yet been typed is not encrypted on the incremental crash-recovery
  save until the fence is closed. Inherent to the fence format + incremental
  save; the editor preview already masks it. A semantic change (treat EOF as an
  implicit close) is riskier than the edge it fixes.

## Deferred product feature — in-app recycle bin

An in-app recycle bin (soft-delete pages into a vault-local trash, a restore /
empty-trash view, and configurable auto-purge — e.g. 30 days) was considered and
**deliberately deferred**. Deletion already has two recovery nets:

- **Single-page delete** (`crud::delete_page`) sends the file to the **OS
  trash / Recycle Bin** (recoverable there).
- The vault is **git-tracked**, so any deleted page — including bulk deletes,
  which skip the OS trash for speed — is recoverable from version history.

Because that safety net already exists, the delete-from-search-results action
routes through the OS trash rather than requiring a new subsystem. A full in-app
bin would add a trash store, restore/empty-trash UI, a retention/auto-purge job
(like the memory TTL cleanup), and a sync-interaction decision (does a trashed
item sync or stay device-local?). Revisit if users ask for in-app restore or a
retention policy they can configure.
