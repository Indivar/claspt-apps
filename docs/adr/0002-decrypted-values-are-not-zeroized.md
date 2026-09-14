# ADR 0002 — Decrypted secret values are not zeroized

- **Status:** Accepted
- **Date:** 2026-08-31
- **Deciders:** Project owner
- **Related:** `src-tauri/src/pages/secret.rs`,
  `crates/claspt-core/src/pages/secret.rs`, `src/components/SecretCard.tsx`,
  [ADR 0001](0001-global-secret-access-approval.md)

## Context

Claspt is careful with key material. `Zeroizing` appears in 98 places across the
Rust codebase: the master key, derived password keys, sync group keys and
recovery keys are all wiped from memory when they go out of scope.

Decrypted secret *values* are not. All six decrypt functions return a plain
`String`:

| Function | Returns |
|---|---|
| `pages::secret::decrypt_secrets` | `String` |
| `pages::secret::decrypt_secrets_for_export` | `String` |
| `pages::secret::decrypt_full_body` | `String` |
| `pages::secret::decrypt_full_body_for_export` | `String` |
| `claspt_core::pages::secret::decrypt_secrets` | `String` |
| `claspt_core::pages::secret::decrypt_full_body` | `String` |

A `String` releases its buffer on drop without overwriting it, so the plaintext
stays in the freed allocation until something reuses that memory. It can
therefore reach a core dump, a swap file, or a hibernation image.

The primitive underneath them does better, which makes the gap easy to miss.
`crypto::vault_key::decrypt_block` returns `Zeroizing<String>`, so the value it
produces is wiped on drop. Its callers then discard that: in
`pages::secret::decrypt_secrets` the very next expression is
`Ok(plaintext.to_string())`, which copies the value into a plain `String` and
leaves the wrapper protecting nothing but a short-lived intermediate. The
protection therefore ends one line above the layer that matters.

The larger problem is where those strings go. Every one crosses the Tauri IPC
boundary into the webview, is serialised to JSON on the way, and is handed to
JavaScript. Inside V8 the value is an immutable, garbage-collected string that
Rust cannot reach and JavaScript cannot overwrite. **Zeroizing the Rust side
would not remove the plaintext from the process**, because by then several
copies exist that no `Drop` implementation can touch: the serialiser's buffer,
the IPC transport, and V8's heap.

Two fixes were considered.

**Partial.** Propagate `Zeroizing<String>` up from `decrypt_block` through the
six functions instead of copying out of it. The Rust copy is wiped; the
serialised copy and the V8 copy are not.

**Complete.** Stop sending plaintext to the webview at all. The UI would request
operations — reveal, copy, fill — that Rust performs against the decrypted value
without ever handing it over, with rendering either done in Rust or fed through a
channel that does not retain. This is how a password manager with a native UI
avoids the problem.

## Decision

**Neither is implemented. The behaviour is documented and deferred.**

The partial fix is rejected on its own terms: it would let the codebase claim
that decrypted values are zeroized when the copies that actually persist are
untouched. A security control that reads as stronger than it is invites people
to rely on it. Wiping one of four copies is not meaningfully different from
wiping none, and the comment explaining that would be doing all the work.

The complete fix is deferred. It is an architectural change to how every secret
reaches the interface — `SecretCard`, the editor's secret rendering, clipboard
handling, the browser extension's fill path, and the mobile equivalents — and it
is disproportionate to the threat at Claspt's current stage. The exposure
requires an attacker who can already read the process's memory, its swap, or its
core dumps. Such an attacker can also read the master key while the vault is
unlocked, which is resident by design so the API and extension can serve
requests. Zeroizing the values while the key that decrypts them stays in memory
closes the smaller hole and leaves the larger one open.

This is the same reasoning as [ADR 0001](0001-global-secret-access-approval.md):
build the permission and memory-hygiene machinery when there is a threat model
that needs it, not ahead of one.

## Consequences

- A decrypted secret can persist in process memory after use, and can therefore
  reach a swap file, a hibernation image, or a crash dump.
- Any security documentation, marketing copy, or threat model **must not claim
  that decrypted values are zeroized or wiped from memory.** Say that key
  material is zeroized, which is true, and say that decrypted values live in
  process memory for as long as the vault is unlocked, which is also true.
- Locking the vault zeroes the master key but does not retroactively remove
  values already decrypted during the session.
- Because the plaintext reaches JavaScript, anything that can execute in the
  webview can read it. The markdown sanitiser is therefore a load-bearing
  security control, not just a correctness one.

## Revisit when

1. Claspt is deployed somewhere memory-dump exposure is part of the threat model
   — shared or managed machines, forensic-recovery requirements, or a compliance
   regime that asks the question directly.
2. The UI is reworked for another reason and secret rendering is already being
   touched, making the complete fix incremental rather than a dedicated project.
3. A cross-platform native secret-rendering path exists for another feature
   (secure clipboard, autofill), at which point routing reveal through it is
   small.
4. Claspt makes an explicit memory-hygiene claim in its marketing or docs, at
   which point the claim must be made true before it is published.

## Alternatives considered

**Propagate `Zeroizing<String>` through the six decrypt functions.** Rejected
above: the misleading impression is worse than the small benefit. Note this is
not merely unimplemented — `decrypt_block` already produces a `Zeroizing<String>`
and the callers deliberately copy out of it, so the change is a small one that
was considered and declined rather than overlooked.

**Zeroize on vault lock by tracking issued plaintexts.** Would require holding
references to every decrypted value, which means keeping them alive longer and
adding a registry that is itself a collection of plaintext secrets. Strictly
worse.

**Disable swap or lock memory pages (`mlock`).** Platform-specific, needs
elevated privileges on some systems, and does nothing about the V8 copy.
Rejected as high cost for partial coverage.
