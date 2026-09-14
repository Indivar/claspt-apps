# ADR 0003 — Secret access approval can be granted per client and per page

- **Status:** Accepted
- **Date:** 2026-09-10
- **Deciders:** Project owner
- **Supersedes:** ADR 0001, in part (the "single session-wide grant" decision;
  the single global `secret_access_mode` stays)
- **Related:** `src-tauri/src/local_api/approval.rs`,
  `src-tauri/src/internal/approval_grants.rs`,
  `src-tauri/src/local_api/clients.rs`, `src-tauri/src/local_api/rate_limit.rs`

## Context

ADR 0001 kept secret-access approval as one vault-wide setting with one
session-wide "remember" grant, and listed five conditions under which that
should be revisited. Its fifth condition was:

> Named tokens are built for any other reason — at which point per-token policy
> is a small increment rather than a new subsystem.

Release 3.3 built named client tokens (3.3.7) for a different reason: so that
an integration can be revoked on its own and so that the access log (3.3.8)
can say who did what. With every request now carrying a client identity, and
every secret read recorded against it, the two consequences ADR 0001 accepted
with reservations no longer need accepting:

- "Remember for this session" granted every client every secret until lock.
- Approval could not differ per client.

## Decision

**Keep the single global `secret_access_mode`. Add a standing grant scoped to
one client and one page, chosen from the prompt as "Always allow <client> to
read this page", persisted until the user revokes it in Settings. Keep the
session-wide grant as an explicit third option, labelled for what it is.**

Also: a per-client limit on decrypting reads per minute (default 15, user
adjustable), so a client in a loop is slowed and logged rather than served.

The reasoning:

- **The grant names what it covers.** A grant is `(client_id, page)`. A page and
  its secret route are the same thing to the user, so both map to the page
  path; anything else is granted by its exact path. The prompt shows exactly
  this target and the client's name.
- **It is revocable in two ways.** Each grant has its own Revoke in Settings,
  and revoking the client removes its grants with it, so an id can never be
  reused into an old approval.
- **It is visible.** The prompt shows how many secrets the client read in the
  last minute; the access log shows every read afterwards.
- **The session-wide grant stays, honestly labelled.** Some users want it. Its
  label now says "every client, every secret, until the vault locks".

## Consequences

- Grants live in `.securenotes/internal/approval-grants.json`, owner-only,
  never synced: they name clients that exist only on this device.
- A grant persists across locks. That is the point, and it is why revocation
  must be one click away.
- The rate limit resets on app restart; the access log, not the limiter, is
  the durable record.
- `secret_access_mode` still defaults to `auto`. Nothing in this ADR changes
  what a secrets token can do when approval is off; it changes what the prompt
  can express when approval is on.

## Revisit when

- A grant needs to cover more than one page (a folder, a tag). Add a target
  form for it rather than widening the existing one.
- `claspt serve` (headless) needs grants without a prompt: the policy file is
  the same shape, `(client, target, allow)`, decided in advance.
