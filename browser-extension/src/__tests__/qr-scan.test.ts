// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * What a scanned QR is allowed to be. The pixel decoding belongs to jsQR and
 * is not retested here; what matters is that a code which is not a two-factor
 * key is refused rather than saved as one, and that the names shown to the
 * person come out of the payload correctly.
 */
import { describe, it, expect } from "vitest";
import { readOtpauth } from "@/background/qr-scan";

describe("readOtpauth", () => {
  it("accepts a normal authenticator payload and splits the label", () => {
    const result = readOtpauth(
      "otpauth://totp/GitHub:me@example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub",
    );
    expect(result).toEqual({
      ok: true,
      uri: "otpauth://totp/GitHub:me@example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub",
      issuer: "GitHub",
      account: "me@example.com",
    });
  });

  it("prefers the issuer parameter over the label prefix", () => {
    // Sites disagree with themselves here, and every authenticator app
    // resolves it the same way: the parameter wins.
    const result = readOtpauth(
      "otpauth://totp/Old%20Name:me@example.com?secret=JBSWY3DPEHPK3PXP&issuer=New%20Name",
    );
    expect(result.ok && result.issuer).toBe("New Name");
  });

  it("handles a label with no issuer prefix", () => {
    const result = readOtpauth("otpauth://totp/me@example.com?secret=JBSWY3DPEHPK3PXP");
    expect(result.ok && result.account).toBe("me@example.com");
    expect(result.ok && result.issuer).toBe("");
  });

  it("decodes a percent-encoded label", () => {
    const result = readOtpauth(
      "otpauth://totp/Acme%20Inc%3Aj.doe%40example.com?secret=JBSWY3DPEHPK3PXP",
    );
    expect(result.ok && result.issuer).toBe("Acme Inc");
    expect(result.ok && result.account).toBe("j.doe@example.com");
  });

  it("refuses a QR that is not a two-factor key", () => {
    // A page can show a payment code, an app-store link or a wifi join.
    // Saving one of those as a key produces numbers that never work.
    for (const text of [
      "https://example.com/app",
      "WIFI:S:MyNetwork;T:WPA;P:hunter2;;",
      "otpauth://hotp/Example:me?secret=JBSWY3DPEHPK3PXP&counter=1",
      "bitcoin:1BoatSLRHtKNngkdXEeobR76b53LETtpyT",
      "",
    ]) {
      expect(readOtpauth(text)).toEqual({ ok: false, reason: "not-totp" });
    }
  });

  it("accepts the scheme in any case, because QR text is not normalised", () => {
    expect(readOtpauth("OTPAUTH://TOTP/Me?secret=JBSWY3DPEHPK3PXP").ok).toBe(true);
  });

  it("tolerates surrounding whitespace from the decoder", () => {
    expect(readOtpauth("  otpauth://totp/Me?secret=JBSWY3DPEHPK3PXP\n").ok).toBe(true);
  });

  it("keeps the key when the label is malformed rather than losing the scan", () => {
    // Only the display names depend on parsing; the secret still works.
    const result = readOtpauth("otpauth://totp/%E0%A4%A?secret=JBSWY3DPEHPK3PXP");
    expect(result.ok).toBe(true);
  });
});
