// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * The seed lookup is shared so the three surfaces cannot disagree. These tests
 * pin the accepted spellings and the priority between them, so dropping a name
 * becomes a deliberate act with a failing test rather than a silent change
 * that makes two-factor work on one surface and not another.
 */
import { describe, it, expect } from "vitest";
import {
  readTotpSeed,
  hasTotp,
  TOTP_FIELD_NAMES,
  CANONICAL_TOTP_FIELD,
  isSensitiveField,
  urlMatchPolicyOf,
} from "@claspt/shared/credential-fields";

describe("readTotpSeed", () => {
  it("reads every spelling the three surfaces used to accept separately", () => {
    // Autofill took otp/totp/otp_secret, the copy menu took
    // totp/otp_secret/authenticator, the inline picker took totp/otp/2fa.
    for (const name of ["totp", "otp", "otp_secret", "authenticator", "2fa"]) {
      expect(readTotpSeed({ [name]: "JBSWY3DPEHPK3PXP" })).toBe("JBSWY3DPEHPK3PXP");
    }
  });

  it("prefers the name Claspt writes when a credential carries two", () => {
    expect(readTotpSeed({ "2fa": "OLD", totp: "NEW" })).toBe("NEW");
    expect(readTotpSeed({ authenticator: "OLD", otp: "NEW" })).toBe("NEW");
  });

  it("treats an empty or whitespace field as no seed at all", () => {
    // An import that kept the column but not the data must not put a
    // "Copy code" item on a credential that can never produce one.
    expect(readTotpSeed({ totp: "" })).toBe("");
    expect(readTotpSeed({ totp: "   " })).toBe("");
    expect(hasTotp({ totp: "  \t " })).toBe(false);
  });

  it("falls through a blank name to a later one that has a value", () => {
    expect(readTotpSeed({ totp: "", otp: "REAL" })).toBe("REAL");
  });

  it("trims what a person pasted with a stray newline", () => {
    expect(readTotpSeed({ totp: " JBSWY3DPEHPK3PXP\n" })).toBe("JBSWY3DPEHPK3PXP");
  });

  it("returns empty for a credential with no two-factor field", () => {
    expect(readTotpSeed({ username: "me", password: "pw" })).toBe("");
    expect(hasTotp({ username: "me", password: "pw" })).toBe(false);
  });

  it("does not treat a field merely called secret as a seed", () => {
    // "secret" is masked in the UI but it is the password on many imports,
    // and filling it into a six-digit box would fail the login.
    expect(readTotpSeed({ secret: "hunter2" })).toBe("");
  });
});

describe("the shared list itself", () => {
  it("names totp first, because that is what the app writes", () => {
    expect(CANONICAL_TOTP_FIELD).toBe("totp");
    expect(TOTP_FIELD_NAMES[0]).toBe("totp");
  });

  it("holds no duplicates and is all lower case", () => {
    expect(new Set(TOTP_FIELD_NAMES).size).toBe(TOTP_FIELD_NAMES.length);
    for (const name of TOTP_FIELD_NAMES) expect(name).toBe(name.toLowerCase());
  });
});

describe("isSensitiveField", () => {
  it("masks every kind of secret, not only passwords", () => {
    for (const k of [
      "password",
      "Pass",
      "totp",
      "otp_secret",
      "api_key",
      "API Key",
      "token",
      "cvv",
      "recovery codes",
      "github token",
      "old password",
      // The template fields that hold a secret in their own right.
      "passphrase",
      "private_key",
      "seed_phrase",
      "Seed Phrase",
      "license_key",
      "Licence Key",
      "card_number",
      "account_number",
      "connection_string",
    ]) {
      expect(isSensitiveField(k), k).toBe(true);
    }
  });
  it("leaves ordinary fields readable", () => {
    for (const k of [
      "username",
      "email",
      "url",
      "notes",
      "url_match",
      "expiry",
      "host",
      "port",
      "ssid",
      "bank_code",
      "document_number",
      "",
    ]) {
      expect(isSensitiveField(k), k).toBe(false);
    }
  });
});

describe("urlMatchPolicyOf", () => {
  it("reads the stored policy and ignores anything else", () => {
    expect(urlMatchPolicyOf({ url_match: "host" })).toBe("host");
    expect(urlMatchPolicyOf({ "url match": "EXACT" })).toBe("exact");
    expect(urlMatchPolicyOf({ url_match: "sometimes" })).toBeUndefined();
    expect(urlMatchPolicyOf({})).toBeUndefined();
  });
});
