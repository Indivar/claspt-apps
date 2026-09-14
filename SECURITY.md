# Security policy

Claspt stores passwords and encryption keys. A security bug here is worse than
a security bug in most software, and we treat reports accordingly.

## Reporting a vulnerability

Email **hello@claspt.app** with the subject line `Security: <short summary>`.
If GitHub private vulnerability reporting is enabled on the repository, that
works too. Please do not open a public issue for anything that could be
exploited.

Include what you can of: the affected component (desktop, browser extension,
mobile, server, website), the version, steps to reproduce, and what an attacker
gains. A proof of concept helps; a working exploit against real users' data is
not needed and should not be attempted.

We will acknowledge within 3 working days, keep you informed while we work on
it, and credit you in the release notes unless you ask us not to. We aim to
ship a fix for a confirmed high-severity issue within 30 days and anything else
within 90.

## Scope

In scope: everything in this repository and the builds made from it, the
Claspt sync and licence server, and the browser extension. The marketing and
documentation sites are in scope for issues that affect users (for example a
download link that could be swapped), not for content or SEO.

Out of scope, because the design accepts them: a process already running as
the logged-in user on an unlocked machine (it can read the OS keychain and the
vault the same way Claspt does); anything requiring the master password; and
plaintext note text, titles, labels, folder names and tags, which are readable
by design so notes stay portable and searchable. The full list is in
[docs/threat-model.md](docs/threat-model.md).

## Safe harbour

Good-faith research that stays within the rules above will not be met with
legal action. Do not access, modify or exfiltrate data that is not yours, do
not degrade the service for others, and give us reasonable time to fix before
publishing.

## Supported versions

Fixes go into the current release only. Desktop, extension and mobile update
themselves or through their stores; there are no long-term support branches.

## What we do ourselves

- Every commit runs formatting, lint, type checks and the test suites in CI,
  and a secret scanner (gitleaks) over the tree.
- Every write that reaches the vault through the API is checked for
  recognisable credentials outside an encrypted block and refused if one is
  found (`src-tauri/src/pages/secret_guard.rs`).
- Design decisions with security consequences are recorded as ADRs in
  `docs/adr/`. Two are worth reading before reporting: secret access approval
  (0001) and why decrypted values are not zeroized (0002).
