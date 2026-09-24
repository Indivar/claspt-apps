// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * The RFC 6238 test vectors, which are the only way to know a TOTP
 * implementation agrees with every authenticator app in the world. A code that
 * is merely six digits and changes every thirty seconds looks correct while
 * being useless, so these pin the arithmetic rather than the shape.
 *
 * The three hash families use three different seeds. Reusing the SHA-1 seed
 * for SHA-256 is the usual way to get vectors that never match, so the seed is
 * derived per algorithm here.
 */
// @vitest-environment node
//
// totp.ts runs in the service worker, where Web Crypto is Node's in this
// suite. Under the shared jsdom environment its ArrayBuffer comes from a
// different realm and importKey rejects every secret, which says nothing
// about the code under test.
import { describe, it, expect } from "vitest";
import { generateTotp, parseOtpauthUri } from "@claspt/shared/totp";

/** RFC 4648 base32, uppercase and unpadded: what an otpauth URI carries. */
function base32Encode(text: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of new TextEncoder().encode(text)) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

/** The seeds are ASCII digits repeated to the hash's block size. */
const SEEDS = {
  "SHA-1": "12345678901234567890",
  "SHA-256": "12345678901234567890123456789012",
  "SHA-512": "1234567890123456789012345678901234567890123456789012345678901234",
};

/** Appendix B of RFC 6238, verbatim: [unix seconds, code] per algorithm. */
const VECTORS: Record<keyof typeof SEEDS, [number, string][]> = {
  "SHA-1": [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ],
  "SHA-256": [
    [59, "46119246"],
    [1111111109, "68084774"],
    [1111111111, "67062674"],
    [1234567890, "91819424"],
    [2000000000, "90698825"],
    [20000000000, "77737706"],
  ],
  "SHA-512": [
    [59, "90693936"],
    [1111111109, "25091201"],
    [1111111111, "99943326"],
    [1234567890, "93441116"],
    [2000000000, "38618901"],
    [20000000000, "47863826"],
  ],
};

/** The URI form is the only way to ask for 8 digits or a non-SHA-1 hash. */
function uriFor(algorithm: keyof typeof SEEDS): string {
  const secret = base32Encode(SEEDS[algorithm]);
  const algo = algorithm.replace("-", "");
  return `otpauth://totp/Example:test@example.com?secret=${secret}&issuer=Example&algorithm=${algo}&digits=8&period=30`;
}

describe("generateTotp against the RFC 6238 vectors", () => {
  for (const algorithm of Object.keys(VECTORS) as (keyof typeof SEEDS)[]) {
    describe(algorithm, () => {
      for (const [seconds, expected] of VECTORS[algorithm]) {
        it(`T=${seconds} gives ${expected}`, async () => {
          const { code } = await generateTotp(uriFor(algorithm), seconds * 1000);
          expect(code).toBe(expected);
        });
      }
    });
  }
});

describe("generateTotp defaults", () => {
  it("a bare base32 secret is SHA-1, six digits, thirty seconds", async () => {
    const secret = base32Encode(SEEDS["SHA-1"]);
    const { code } = await generateTotp(secret, 59_000);
    // The same vector as above, truncated to the six digits an app shows.
    expect(code).toBe("94287082".slice(-6));
  });

  it("counts down within the period rather than up", async () => {
    const secret = base32Encode(SEEDS["SHA-1"]);
    expect((await generateTotp(secret, 0)).remaining).toBe(30);
    expect((await generateTotp(secret, 1_000)).remaining).toBe(29);
    expect((await generateTotp(secret, 29_000)).remaining).toBe(1);
    expect((await generateTotp(secret, 30_000)).remaining).toBe(30);
  });

  it("the code changes exactly on the period boundary", async () => {
    const secret = base32Encode(SEEDS["SHA-1"]);
    const before = await generateTotp(secret, 29_999);
    const at = await generateTotp(secret, 30_000);
    const within = await generateTotp(secret, 59_999);
    expect(at.code).not.toBe(before.code);
    expect(within.code).toBe(at.code);
  });

  it("accepts the spaces and padding people paste from a website", async () => {
    const plain = base32Encode(SEEDS["SHA-1"]);
    const spaced = plain.match(/.{1,4}/g)!.join(" ").toLowerCase() + "====";
    expect((await generateTotp(spaced, 59_000)).code).toBe(
      (await generateTotp(plain, 59_000)).code,
    );
  });
});

describe("parseOtpauthUri", () => {
  it("reads the label, issuer and parameters", () => {
    const parsed = parseOtpauthUri(uriFor("SHA-256"));
    expect(parsed.issuer).toBe("Example");
    expect(parsed.account).toBe("test@example.com");
    expect(parsed.digits).toBe(8);
    expect(parsed.period).toBe(30);
    expect(parsed.algorithm).toBe("SHA256");
  });

  it("falls back to SHA-1, six digits and thirty seconds when unstated", () => {
    const secret = base32Encode(SEEDS["SHA-1"]);
    const parsed = parseOtpauthUri(`otpauth://totp/GitHub:me?secret=${secret}`);
    expect(parsed.algorithm).toBe("SHA1");
    expect(parsed.digits).toBe(6);
    expect(parsed.period).toBe(30);
  });
});
