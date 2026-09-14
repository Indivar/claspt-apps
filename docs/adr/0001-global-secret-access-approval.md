# ADR 0001 — Secret access approval stays a single global setting

- **Status:** Accepted
- **Date:** 2026-08-31
- **Deciders:** Project owner
- **Supersedes:** nothing
- **Related:** `src-tauri/src/local_api/auth.rs`, `src-tauri/src/local_api/approval.rs`,
  `src-tauri/src/vault/config.rs`

## Context

Claspt exposes a local HTTP API on `127.0.0.1` and an MCP server over stdio, so
AI agents and the browser extension can read and write the vault. Two bearer
tokens gate it:

| Config field | Prefix | Capability |
|---|---|---|
| `local_api_notes_token` | `clsn_` | Pages, search, folders. Secret bodies redacted. |
| `local_api_secrets_token` | `clss_` | The above, plus decryption of secret values. |

There is exactly one token of each kind per vault. Every client — an agent, the
extension, a user script — presents the same string, so the server cannot
distinguish between them.

A vault-wide setting, `secret_access_mode`, is either `"auto"` or `"approve"`
and defaults to auto. Under `"approve"`, a request bearing the secrets token
raises a desktop dialog and blocks for up to 30 seconds awaiting a decision. The
dialog offers "Remember for this session", which sets a single boolean on
`ApprovalManager`; that boolean is cleared on vault lock.

A security audit in August 2026 recorded three consequences of this shape:

1. **The setting is vault-wide.** Approval cannot differ per client, because
   there is only one secrets token to attach a policy to.
2. **The grant is unscoped.** `session_approved` is a lone `Mutex<bool>`, not a
   map keyed by token, page, or secret. One approval with "remember" ticked
   auto-approves every later secrets request, for every secret, until lock.
3. **The prompt is not legible.** `tool_name` and `page_path` are both set to
   the raw request path, so the user approves a URL rather than a named
   credential.

These compound: because one approval grants the whole vault, "remember" is
genuinely risky; because it is risky, the mode cannot responsibly be defaulted
on; because it is off by default, most users never see a prompt at all.

A redesign was proposed — scope each grant to the page or secret it was given
for, time-bound it, make the prompt name the credential, and optionally allow
multiple named tokens each carrying its own policy.

## Decision

**Keep the single global `secret_access_mode` and the single session-wide grant.
Do not build scoped grants, time-bounded grants, or named per-client tokens at
this time.**

The reasoning:

- **The exposure is local only.** The API binds the loopback interface and
  requires a bearer token. Nothing is reachable from another machine. The
  adversary this redesign defends against is a process already running as the
  user — malware, or an agent under prompt injection that legitimately holds
  the token. In most such scenarios the attacker has better options than the
  vault API.
- **Consent is already explicit and coarse.** Enabling the local API and pasting
  a secrets token into an agent's configuration is a deliberate act. The user
  granting it understands they are handing local access to that tool.
- **No user has asked for it.** Building a permissions model ahead of the demand
  for one adds surface area, configuration, and failure modes that must then be
  maintained and documented — for a threat no user has raised.
- **Per-token policy implies multiple tokens.** With one `clss_` token there is
  nothing to differentiate. Making approval per-token therefore pulls in token
  minting, naming, listing, storage, and revocation. That is a feature, not a
  hardening pass, and it deserves to be justified on its own merits rather than
  arriving as a side effect of a security fix.

## Consequences

Accepted, with eyes open:

- A user who ticks "Remember for this session" grants unprompted access to every
  secret in the vault until the vault locks. This must be described accurately
  wherever the option is presented — the checkbox label and any documentation
  must not imply the grant is narrower than it is.
- `secret_access_mode` stays `auto` by default, so a secrets token decrypts
  without prompting. The setup flow must therefore be honest that handing out a
  secrets token is handing out the vault's secrets.
- Approval cannot be varied per client. A user who wants the extension
  unprompted but an agent gated cannot express that.
- The approval dialog names a request path rather than a credential.

Not accepted, and **fixed separately** — these are defects in the design being
kept, not arguments for changing it:

- The approval check sat inside `if let Ok(config)`, so an unreadable config
  skipped the check and granted access. Fail-open. Fixed.
- Regenerating a token may not invalidate the previous one until the app
  restarts, because the API context captures tokens by value at startup.
- Several mutating routes lack scope guards, and one takes no auth argument at
  all.

## Revisit when

Any one of these should reopen the decision:

1. Claspt gains multi-user, team, or shared-vault features, so "the user" is no
   longer a single person at a single machine.
2. The API becomes reachable beyond loopback — a remote agent bridge, a
   companion service, or tunnelling for a mobile client.
3. Users ask to run several agents against one vault with different levels of
   trust between them.
4. A prompt-injection incident is reported against an agent holding a secrets
   token, demonstrating the threat in practice rather than in principle.
5. Named tokens are built for any other reason — at which point per-token policy
   is a small increment rather than a new subsystem.

## Alternatives considered

**Scoped and time-bounded grants, without named tokens.** Replace the boolean
with a map keyed by page or secret label, expire entries after a few minutes,
and show the credential's name in the prompt. This addresses the sharpest edge —
one approval granting everything — without any token infrastructure, and would
make the mode safe to default on. Deferred rather than rejected; this is the
first thing to build if the decision is revisited.

**Named per-client tokens with individual policies.** The complete answer, and
the largest. Requires minting, naming, listing, revocation, and per-token
settings, plus onboarding changes so each client gets its own token. Rejected
for now as disproportionate to a loopback-only threat.

**Defaulting `secret_access_mode` to `approve` as-is.** Rejected: with an
unscoped grant, the first prompt a user sees trains them to tick "remember",
which disables the protection permanently. A control that users are incentivised
to switch off is worse than no control, because it implies safety that is not
there.

## Superseded in part

2026-09-10: ADR 0003 adds per-client, per-page standing grants and a per-client
rate limit, on the terms this ADR's "Revisit when" item 5 set out. The single
global `secret_access_mode` and the session-wide grant remain.
