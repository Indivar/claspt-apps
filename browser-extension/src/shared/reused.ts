// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import type { Credential } from "./types";

/**
 * Detect passwords reused across credentials. Returns a set of SHA-256
 * hex digests that appear in 2+ credentials, plus a per-credential lookup.
 *
 * Hashing is done locally with the Web Crypto API — passwords never leave
 * the device. This is a pure local check, not an HIBP/breach lookup.
 */

function getPasswordValue(c: Credential): string | null {
  const v = c.fields["password"] ?? c.fields["pass"] ?? c.fields["secret"];
  return v && v.trim().length > 0 ? v : null;
}

export function credentialKey(c: Credential): string {
  return `${c.pagePath}::${c.label}`;
}

async function sha256Hex(value: string): Promise<string> {
  const buf = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

export interface ReusedReport {
  /** SHA-256 hashes that appear in 2+ credentials. */
  reusedHashes: Set<string>;
  /** Map credentialKey -> { hash, reuseCount } when password present. */
  byCredential: Map<string, { hash: string; reuseCount: number }>;
  /** Total count of credentials whose password is reused. */
  reusedCount: number;
}

export async function detectReusedPasswords(creds: Credential[]): Promise<ReusedReport> {
  const counts = new Map<string, number>();
  const perCred: Array<{ key: string; hash: string }> = [];

  for (const c of creds) {
    const pw = getPasswordValue(c);
    if (!pw) continue;
    const hash = await sha256Hex(pw);
    counts.set(hash, (counts.get(hash) ?? 0) + 1);
    perCred.push({ key: credentialKey(c), hash });
  }

  const reusedHashes = new Set<string>();
  for (const [hash, count] of counts) {
    if (count >= 2) reusedHashes.add(hash);
  }

  const byCredential = new Map<string, { hash: string; reuseCount: number }>();
  for (const { key, hash } of perCred) {
    byCredential.set(key, { hash, reuseCount: counts.get(hash) ?? 0 });
  }

  let reusedCount = 0;
  for (const [, info] of byCredential) {
    if (info.reuseCount >= 2) reusedCount++;
  }

  return { reusedHashes, byCredential, reusedCount };
}
