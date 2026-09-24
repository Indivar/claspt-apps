// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * TOTP (Time-based One-Time Password) implementation per RFC 6238.
 * Uses Web Crypto API — works in service workers and content scripts.
 *
 * Supports:
 * - otpauth:// URIs (from Google Authenticator, etc.)
 * - Raw base32-encoded secrets
 * - Configurable period (default 30s) and digits (default 6)
 */

/** Parse a base32-encoded string into a Uint8Array. */
function base32Decode(encoded: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const cleaned = encoded.replace(/[\s=-]/g, "").toUpperCase();

  let bits = 0;
  let value = 0;
  const output: number[] = [];

  for (const char of cleaned) {
    const idx = alphabet.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return new Uint8Array(output);
}

/** Parse an otpauth:// URI into its components. */
export function parseOtpauthUri(uri: string): {
  secret: string;
  period: number;
  digits: number;
  algorithm: string;
  issuer?: string;
  account?: string;
} {
  const url = new URL(uri);
  const params = url.searchParams;
  const path = decodeURIComponent(url.pathname.slice(1)); // remove leading /
  const parts = path.includes(":") ? path.split(":") : [undefined, path];

  return {
    secret: params.get("secret") || "",
    period: parseInt(params.get("period") || "30", 10),
    digits: parseInt(params.get("digits") || "6", 10),
    algorithm: params.get("algorithm") || "SHA1",
    issuer: params.get("issuer") || parts[0],
    account: parts[1] || parts[0],
  };
}

/**
 * Generate a TOTP code from a secret.
 *
 * @param secret - Base32-encoded secret or otpauth:// URI
 * @param now - Current timestamp in milliseconds (default: Date.now())
 * @returns The code, the seconds left on it, and the period it belongs to.
 *          The period is returned because a caller drawing a countdown
 *          cannot otherwise know whether to scale it against 30 or 60, and
 *          guessing 30 makes a 60-second credential appear to freeze.
 */
export async function generateTotp(
  secret: string,
  now: number = Date.now(),
): Promise<{ code: string; remaining: number; period: number }> {
  let secretBytes: Uint8Array;
  let period = 30;
  let digits = 6;
  let algorithm = "SHA-1";

  if (secret.startsWith("otpauth://")) {
    const parsed = parseOtpauthUri(secret);
    secretBytes = base32Decode(parsed.secret);
    period = parsed.period;
    digits = parsed.digits;
    // Map otpauth algorithm names to Web Crypto hash names
    const algoMap: Record<string, string> = {
      SHA1: "SHA-1",
      SHA256: "SHA-256",
      SHA512: "SHA-512",
    };
    algorithm = algoMap[parsed.algorithm.toUpperCase()] || "SHA-1";
  } else {
    secretBytes = base32Decode(secret);
  }

  const timeStep = Math.floor(now / 1000 / period);
  const remaining = period - (Math.floor(now / 1000) % period);

  // Convert time step to 8-byte big-endian buffer
  const timeBuffer = new ArrayBuffer(8);
  const timeView = new DataView(timeBuffer);
  timeView.setUint32(4, timeStep, false); // big-endian, lower 32 bits

  // HMAC-SHA1
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes.buffer as ArrayBuffer,
    { name: "HMAC", hash: algorithm },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, timeBuffer);
  const hmac = new Uint8Array(signature);

  // Dynamic truncation (RFC 4226 section 5.4). The offset is four bits, so it
  // is at most 15 and the four bytes it selects always exist in a 20-byte
  // SHA-1 digest. The reads are still written to survive a short digest
  // rather than produce a silently wrong code from undefined bytes.
  const at = (i: number): number => hmac[i] ?? 0;
  const offset = at(hmac.length - 1) & 0x0f;
  const binary =
    ((at(offset) & 0x7f) << 24) |
    ((at(offset + 1) & 0xff) << 16) |
    ((at(offset + 2) & 0xff) << 8) |
    (at(offset + 3) & 0xff);

  const otp = binary % Math.pow(10, digits);
  const code = otp.toString().padStart(digits, "0");

  return { code, remaining, period };
}
