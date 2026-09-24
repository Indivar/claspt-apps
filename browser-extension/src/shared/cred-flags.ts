// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import type { Credential } from "./types";

/**
 * Per-credential boolean flags stored in the secret block alongside other
 * fields (`primary: true`, `deprecated: true`). Vault-stored, syncs across
 * devices via the desktop's git auto-commit.
 */

function isTruthy(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.toLowerCase().trim();
  return s === "true" || s === "yes" || s === "1" || s === "y";
}

export function isPrimary(c: Credential): boolean {
  return isTruthy(c.fields["primary"]);
}

export function isDeprecated(c: Credential): boolean {
  return isTruthy(c.fields["deprecated"]) || isTruthy(c.fields["legacy"]);
}

/**
 * Sort comparator factor for primary credentials. Used in addition to pin +
 * last-used: primary beats pin, pin beats recency, recency beats rest.
 */
export function statusBucket(c: Credential): number {
  if (isDeprecated(c)) return 3; // deprecated → bottom
  if (isPrimary(c)) return 0;    // primary → top
  return 1;                       // normal
}

/**
 * Whether a credential's label already shows the username, so a picker row
 * would only repeat it on a second line.
 *
 * Most saved credentials are named after the account they hold
 * ("google - alice@example.com"), and the picker used to print the label and
 * the username side by side on one line, both truncated to fit. That produced
 * rows like "google - alice@ex… · alice@exam…", which identify nothing.
 */
export function labelShowsUsername(label: string, username: string): boolean {
  if (!username) return false;
  return label.toLowerCase().includes(username.toLowerCase());
}
