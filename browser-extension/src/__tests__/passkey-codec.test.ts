// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { describe, it, expect } from "vitest";
import {
  assertionToCredential,
  creationOptionsToRequest,
  fromBase64Url,
  registrationToCredential,
  requestOptionsToRequest,
  toBase64Url,
  rpIdAllowedForHost,
  passkeyOriginFrom,
} from "@/shared/passkey-codec";

const bytes = (...b: number[]) => new Uint8Array(b);

describe("base64url", () => {
  it("round-trips without padding", () => {
    const original = bytes(0, 1, 2, 250, 251, 252, 253, 254, 255);
    const text = toBase64Url(original);
    expect(text).not.toMatch(/[+/=]/);
    expect(new Uint8Array(fromBase64Url(text))).toEqual(original);
    expect(toBase64Url(new Uint8Array(0))).toBe("");
  });
});

describe("creationOptionsToRequest", () => {
  const options = (
    extra: Partial<PublicKeyCredentialCreationOptions> = {},
  ): CredentialCreationOptions => ({
    publicKey: {
      rp: { id: "example.com", name: "Example" },
      user: { id: bytes(1, 2, 3), name: "alice", displayName: "Alice" },
      challenge: bytes(9, 9, 9),
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      excludeCredentials: [{ type: "public-key", id: bytes(4, 4) }],
      ...extra,
    },
  });

  it("translates a public-key creation to the API request", () => {
    const req = creationOptionsToRequest(options(), "https://login.example.com");
    expect(req).toEqual({
      origin: "https://login.example.com",
      cross_origin: false,
      rp: { id: "example.com", name: "Example" },
      user: { id: "AQID", name: "alice", display_name: "Alice" },
      challenge: "CQkJ",
      pub_key_cred_params: [-7, -257],
      exclude_credentials: ["BAQ"],
    });
  });

  it("defaults the rp id to the origin host and declines what it cannot serve", () => {
    const noRpId = creationOptionsToRequest(
      options({ rp: { name: "Example" } }),
      "https://app.example.com",
    );
    expect(noRpId?.rp.id).toBe("app.example.com");
    expect(creationOptionsToRequest(undefined, "https://x")).toBeNull();
    expect(creationOptionsToRequest({}, "https://x")).toBeNull();
    const rsaOnly = options({ pubKeyCredParams: [{ type: "public-key", alg: -257 }] });
    expect(creationOptionsToRequest(rsaOnly, "https://example.com")).toBeNull();
    const platform = options({
      authenticatorSelection: { authenticatorAttachment: "platform" },
    });
    expect(creationOptionsToRequest(platform, "https://example.com")).toBeNull();
  });
});

describe("requestOptionsToRequest", () => {
  it("translates a get with and without allowCredentials", () => {
    const req = requestOptionsToRequest(
      {
        publicKey: {
          challenge: bytes(1),
          rpId: "example.com",
          allowCredentials: [{ type: "public-key", id: bytes(7) }],
        },
      },
      "https://example.com",
    );
    expect(req).toEqual({
      origin: "https://example.com",
      cross_origin: false,
      rp_id: "example.com",
      challenge: "AQ",
      allow_credentials: ["Bw"],
    });
    const bare = requestOptionsToRequest(
      { publicKey: { challenge: bytes(1) } },
      "https://sub.example.com",
    );
    expect(bare?.rp_id).toBe("sub.example.com");
    expect(bare?.allow_credentials).toEqual([]);
    expect(requestOptionsToRequest({ mediation: "silent" }, "https://x")).toBeNull();
  });
});

describe("credential objects", () => {
  it("shape a registration like a PublicKeyCredential", () => {
    const cred = registrationToCredential({
      credential_id: "AQID",
      client_data_json: toBase64Url(
        new TextEncoder().encode('{"type":"webauthn.create"}'),
      ),
      attestation_object: "oQ",
      authenticator_data: "AAAA",
      public_key: "MFk",
      public_key_algorithm: -7,
    });
    expect(cred.id).toBe("AQID");
    expect(new Uint8Array(cred.rawId)).toEqual(bytes(1, 2, 3));
    expect(cred.type).toBe("public-key");
    expect(new TextDecoder().decode(cred.response.clientDataJSON)).toContain(
      "webauthn.create",
    );
    expect(cred.response.getPublicKeyAlgorithm()).toBe(-7);
    expect(cred.response.getTransports()).toContain("internal");
    expect(cred.toJSON().response.attestationObject).toBe("oQ");
    expect(cred.getClientExtensionResults()).toEqual({ credProps: { rk: true } });
  });

  it("shape an assertion, with a null user handle when absent", () => {
    const cred = assertionToCredential({
      credential_id: "AQ",
      client_data_json: "e30",
      authenticator_data: "AAAA",
      signature: "MEU",
      user_handle: "",
    });
    expect(cred.response.userHandle).toBeNull();
    expect(cred.toJSON().response.userHandle).toBeNull();
    const withHandle = assertionToCredential({
      credential_id: "AQ",
      client_data_json: "e30",
      authenticator_data: "AAAA",
      signature: "MEU",
      user_handle: "dXNlcg",
    });
    expect(new TextDecoder().decode(withHandle.response.userHandle as ArrayBuffer)).toBe(
      "user",
    );
  });
});

describe("rpIdAllowedForHost", () => {
  // The WebAuthn rule, applied by us because the page cannot be trusted to.
  it("accepts the host itself and its registrable-domain suffixes", () => {
    expect(rpIdAllowedForHost("github.com", "github.com")).toBe(true);
    expect(rpIdAllowedForHost("login.github.com", "github.com")).toBe(true);
    expect(rpIdAllowedForHost("a.login.example.com", "login.example.com")).toBe(true);
    expect(rpIdAllowedForHost("app.example.co.uk", "example.co.uk")).toBe(true);
    expect(rpIdAllowedForHost("GitHub.com.", "github.com")).toBe(true);
  });

  it("refuses a public suffix, which strangers share", () => {
    expect(rpIdAllowedForHost("user.github.io", "github.io")).toBe(false);
    expect(rpIdAllowedForHost("www.example.co.uk", "co.uk")).toBe(false);
    expect(rpIdAllowedForHost("shop.example.com", "com")).toBe(false);
  });

  it("refuses any host that is not a suffix match on a label boundary", () => {
    // The attack: evil.com asks for github.com. Also the lookalike.
    expect(rpIdAllowedForHost("evil.com", "github.com")).toBe(false);
    expect(rpIdAllowedForHost("evil-github.com", "github.com")).toBe(false);
    expect(rpIdAllowedForHost("github.com.evil.com", "github.com")).toBe(false);
    expect(rpIdAllowedForHost("github.com", "login.github.com")).toBe(false);
  });

  it("compares loopback and IP hosts whole", () => {
    expect(rpIdAllowedForHost("127.0.0.1", "127.0.0.1")).toBe(true);
    expect(rpIdAllowedForHost("127.0.0.1", "0.0.1")).toBe(false);
    expect(rpIdAllowedForHost("localhost", "localhost")).toBe(true);
  });

  it("refuses empty input", () => {
    expect(rpIdAllowedForHost("", "github.com")).toBe(false);
    expect(rpIdAllowedForHost("github.com", "")).toBe(false);
  });
});

describe("passkeyOriginFrom", () => {
  it("returns the origin for https and loopback http only", () => {
    expect(passkeyOriginFrom("https://shop.example.com/checkout?x=1")).toBe(
      "https://shop.example.com",
    );
    expect(passkeyOriginFrom("http://localhost:3000/login")).toBe(
      "http://localhost:3000",
    );
    expect(passkeyOriginFrom("http://127.0.0.1/")).toBe("http://127.0.0.1");
  });

  it("refuses insecure, extension, and missing URLs", () => {
    expect(passkeyOriginFrom("http://shop.example.com/")).toBeNull();
    expect(passkeyOriginFrom("chrome-extension://abc/popup.html")).toBeNull();
    expect(passkeyOriginFrom("not a url")).toBeNull();
    expect(passkeyOriginFrom(undefined)).toBeNull();
  });
});
