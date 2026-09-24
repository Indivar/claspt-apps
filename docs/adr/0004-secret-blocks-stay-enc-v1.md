# ADR 0004: Secret blocks stay `enc:v1`, with no associated data

**Status:** accepted, 2026-08-31

## Context

A secret block's value is sealed with AES-256-GCM under the vault's master key
and stored as `enc:v1:<base64>`. The seal carries no associated data, so the
ciphertext is not bound to the block's label, its page, or its position. Someone
with write access to the vault's `.md` files can move an `enc:v1:` blob under a
different label and it still decrypts.

A proposed `enc:v2` would have bound `page_id + label` as associated data.

## Decision

`enc:v1` stays. Associated-data binding is not being added, and the limitation is
recorded as accepted rather than as planned work.

## Reasons

- The gap is narrow. The attacker must already have write access to the files
  on the machine. With that access they can read the plaintext markdown around
  every block, replace the app, or wait for the vault to be unlocked; relabelling
  a secret is the least of what they can do. No plaintext is disclosed by the
  relocation.
- The fix is wide. Three platforms (desktop, browser extension, mobile) read
  secret blocks through `claspt-core`. A new format needs every platform to read
  `v2` before any platform writes it, a bulk migration tool for existing vaults,
  and a release sequence that App Store review timing does not let anyone
  control. Each of those is a way for a vault to become unreadable.
- A "warn on label rename" feature is not a substitute and must not be
  described as one: any record of previous labels is editable by the same person
  who edited the label. Renames that arrive through the API or MCP path can be
  attributed to a client, and that belongs with vault observability, not with
  the block format.

## Consequences

- Documentation, the threat model and the code comment on `encrypt_block`
  describe the missing binding as an accepted limitation, not a migration in
  progress.
- Reopening this needs a new justification, not the same one.
