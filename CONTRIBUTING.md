# Contributing to Claspt

Thank you. This document is short on purpose: the rules that matter are few,
and they are not negotiable, because this is a password manager.

## Before you start

- Read [docs/threat-model.md](docs/threat-model.md). Most rejected changes are
  rejected because they move something across a boundary described there.
- Read the engineering standard below. Every change is held to it.
- Open an issue before a large change. A design that is agreed first is a
  pull request that merges.

## Engineering standard

Claspt is a password manager. Every line is written for public review and for
the long term. There are no exceptions to this section.

1. **No shortcuts.** Nothing is done the quicker way because it is "for now",
   only for one release, or only on one platform. It is done properly or it is
   not committed.
2. **No temporary code.** No `TODO: fix later` in place of the fix, no stubbed
   branch that silently succeeds, no duplicated logic to avoid coordination.
   If two places need the same behaviour, share the code or add a test that
   fails when they diverge.
3. **No fancy code.** Ordinary, boring, well-understood constructs. Clever
   generics, macro tricks and unusual patterns are a cost every future reader
   pays. Plain code that is obviously correct beats compact code that needs
   explaining.
4. **Security is not traded away.** Never weaken a default, widen a scope, or
   skip a check to make something easier. If a control makes a feature
   awkward, redesign the feature. Fail closed. Validate at the boundary. Never
   log, cache or persist a decrypted value.
5. **Consistency over preference.** Match the conventions already in the file
   and the module. Rust: `cargo fmt`, `cargo clippy` clean, `Result` over
   panic, `zeroize` for key material. TypeScript: `eslint` and `prettier`
   clean, no `any`, no `setState` in `useEffect`.
6. **Every change is tested.** A bug fix starts with a test that reproduces
   the bug. New behaviour ships with tests for the normal case, the boundary
   and the failure. A security fix additionally gets a test that asserts the
   attack no longer works.
7. **Every change is cross-platform.** Desktop, browser extension and mobile
   share the same guarantees. Platform-specific code gets an implementation on
   every platform it applies to, never a `#[cfg]` block that silently does
   nothing.
8. **Comments explain why, never what.** The code says what it does. A comment
   earns its place by recording the reason, the constraint, or the non-obvious
   consequence.
9. **Say so when it is not done.** Partial, blocked or deferred work is stated
   plainly in the commit message and the pull request, never reported as
   complete.

## Setting up

You need Rust (see `rust-version` in `src-tauri/Cargo.toml`), Node.js 20, and
the Tauri 2 system dependencies for your platform. The full walk-through is in
[docs/development/setup-guide.md](docs/development/setup-guide.md).

```bash
npm install
cargo tauri dev                      # desktop app with hot reload
cd src-tauri && cargo test --lib     # Rust tests (--lib is required)
npx vitest                           # frontend tests
npx eslint src/ && npx prettier --check src/
cd src-tauri && cargo clippy --all-targets && cargo fmt --check
```

The browser extension lives in `browser-extension/`, the mobile app in
`mobile/`, shared TypeScript in `shared/`, and the sync server in `server/`.
Each has its own `package.json` and test command.

## Versioning

Every commit bumps the version of each component it changes. The desktop
version lives in `package.json` only; `npm run version:sync` propagates it to
`Cargo.toml` and `tauri.conf.json`. The extension, `shared/` and `claspt-core`
carry their own versions.

## Secrets

Never commit a credential, even a test one that looks real. CI runs gitleaks
over every push and pull request and will fail the build. To catch it before
that, install the hook once:

```bash
git config core.hooksPath scripts/git-hooks
```

It runs `gitleaks protect --staged` on every commit and needs
[gitleaks](https://github.com/gitleaks/gitleaks) on your PATH. Test fixtures
that need a credential-shaped string use the vendors' documented example values
and live in files listed in `.gitleaks.toml`.

## Contributor License Agreement

Claspt is source-available under the PolyForm Shield License, and the same
code ships inside Indivar's commercial products. To merge your work, Indivar
needs the right to distribute it under both, so contributors sign the
[Contributor License Agreement](CLA.md) once, on their first pull request,
through the CLA check. You keep your copyright; the agreement is a licence
grant, not an assignment. Nothing is merged without it.

Every source file carries a copyright header. `node scripts/check-headers.mjs`
verifies them and `--fix` adds one to a new file; CI runs the check.

## Pull requests

- One change per pull request. Refactors travel separately from behaviour.
- The description says what changed, why, and how it was tested. If a step
  was skipped, say which.
- CI must be green: format, lint, types, clippy with warnings denied, all test
  suites, and the secret scan.
- Reviewers will ask for a test if there is none. That is not a formality.

## Two repositories, one boundary

The public repository is a snapshot of this project's public subset; the
commercial modules (sync, sharing, the licence system, the mobile apps and the
server) live only in the private repository. `.publicignore` is the single
definition of that boundary. Contributions to the public repository are merged
into the private one; fixes made privately are cherry-picked out, which only
works when every commit stays on one side of the boundary. With the hooks
enabled (above), a commit that mixes sides is refused before it is made.

`node scripts/export-public.mjs --out <dir> --check` builds the public tree and
scans it for personal or internal references; CI runs the same export and
builds the result on its own.
