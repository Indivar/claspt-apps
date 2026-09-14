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
