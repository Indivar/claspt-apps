// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Which field on a credential holds the two-factor seed.
 *
 * Three places used to answer this differently: autofill took
 * `otp`/`totp`/`otp_secret`, the popup's copy menu took
 * `totp`/`otp_secret`/`authenticator`, and the inline picker took
 * `totp`/`otp`/`2fa`. Only `totp` worked everywhere, so a credential named
 * `otp` would fill a login form but offer no copy item, and one named
 * `authenticator` would offer the item and never fill. To the person using it
 * the feature simply worked at random.
 *
 * Reading the seed through one function is what stops that recurring: a new
 * caller cannot accidentally pick its own spelling, and adding a name here
 * adds it everywhere at once.
 */

/**
 * Accepted spellings, in priority order. A credential carrying two of these
 * is ambiguous, so the order is fixed rather than incidental: `totp` is the
 * name the app writes itself, and the rest are what imports and hand-editing
 * produce.
 */
export const TOTP_FIELD_NAMES = [
  "totp",
  "otp",
  "otp_secret",
  "authenticator",
  "2fa",
] as const;

/** The field name Claspt writes when it saves a seed of its own. */
export const CANONICAL_TOTP_FIELD = TOTP_FIELD_NAMES[0];

/**
 * The two-factor seed on a credential, or `""` when it has none.
 *
 * Returns `""` rather than `undefined` because every caller goes on to ask
 * "is there a seed", and one falsy answer is easier to get right than two.
 * Whitespace-only values count as absent: they come from an import that kept
 * the column but not the data, and treating them as present puts a
 * "Copy code" item on a credential that can never produce one.
 */
export function readTotpSeed(fields: Record<string, string>): string {
  for (const name of TOTP_FIELD_NAMES) {
    const value = fields[name];
    if (value && value.trim()) return value.trim();
  }
  return "";
}

/** Whether this credential can produce a two-factor code. */
export function hasTotp(fields: Record<string, string>): boolean {
  return readTotpSeed(fields) !== "";
}

/** Field names whose value is a secret in its own right, beyond passwords. */
const SENSITIVE_FIELD_NAMES = new Set<string>([
  "password",
  "pass",
  "passwd",
  "pwd",
  "secret",
  "api_key",
  "apikey",
  "api key",
  "token",
  "access_token",
  "refresh_token",
  "private_key",
  "private key",
  "pin",
  "cvv",
  "cvc",
  "recovery",
  "recovery codes",
  "backup codes",
  "2fa backup",
  "seed",
  "mnemonic",
  ...TOTP_FIELD_NAMES,
]);

/**
 * Whether a field's value must be masked on screen and cleared from the
 * clipboard after a copy.
 *
 * The inline picker masked only `password`, `pass` and `secret`, and printed
 * everything else in the clear, including the two-factor seed, API keys and
 * recovery codes, while the popup masked a different list. One rule now,
 * shared by both. A name that merely contains one of the usual words counts
 * too, so "github token" and "old password" are covered without a list that
 * can never be complete.
 */
export function isSensitiveField(key: string): boolean {
  const name = key.trim().toLowerCase();
  if (!name) return false;
  if (SENSITIVE_FIELD_NAMES.has(name)) return true;
  return /(password|passwd|passphrase|secret|token|api[ _-]?key|private[ _-]?key|recovery|backup code|licen[cs]e[ _-]?key|seed|mnemonic|card[ _-]?number|account[ _-]?number|connection[ _-]?string)/.test(
    name,
  );
}

export type UrlMatchPolicy = "base_domain" | "host" | "exact" | "never";

/** The per-credential URL matching policy stored on the block, if any. */
export function urlMatchPolicyOf(
  fields: Record<string, string>,
): UrlMatchPolicy | undefined {
  const raw = (fields["url_match"] || fields["url match"] || "").toLowerCase().trim();
  return raw === "base_domain" || raw === "host" || raw === "exact" || raw === "never"
    ? raw
    : undefined;
}
