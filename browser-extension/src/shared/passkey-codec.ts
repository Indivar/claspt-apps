// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { getRegistrableDomain } from "./url-matching";
// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * passkey-codec — the translations between what a page passes to
 * `navigator.credentials`, what crosses the page/extension boundary as
 * plain JSON, what the desktop API takes, and what the page gets back.
 * Pure functions so every step is testable without a browser.
 */

export function toBase64Url(bytes: ArrayBuffer | ArrayBufferView): string {
  const view =
    bytes instanceof ArrayBuffer
      ? new Uint8Array(bytes)
      : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let binary = "";
  for (const b of view) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): ArrayBuffer {
  const padded =
    text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out.buffer;
}

/** A creation request as it crosses the page boundary and reaches the API. */
export interface PasskeyCreateRequest {
  origin: string;
  cross_origin: boolean;
  rp: { id: string; name: string };
  user: { id: string; name: string; display_name: string };
  challenge: string;
  pub_key_cred_params: number[];
  exclude_credentials: string[];
}

export interface PasskeyGetRequest {
  origin: string;
  cross_origin: boolean;
  rp_id: string;
  challenge: string;
  allow_credentials: string[];
}

/** The desktop's registration result, all base64url. */
export interface RegistrationResult {
  credential_id: string;
  client_data_json: string;
  attestation_object: string;
  authenticator_data: string;
  public_key: string;
  public_key_algorithm: number;
}

export interface AssertionResult {
  credential_id: string;
  client_data_json: string;
  authenticator_data: string;
  signature: string;
  user_handle: string;
}

export interface PasskeyCandidate {
  credential_id: string;
  user_name: string;
  user_display_name: string;
  label: string;
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return "";
  }
}

/**
 * `navigator.credentials.create({ publicKey })` options to the request the
 * desktop takes. Returns null for anything that is not a public-key
 * creation this provider handles (no `publicKey`, or an RP that only takes
 * algorithms we do not have), so the caller falls back to the browser.
 */
export function creationOptionsToRequest(
  options: CredentialCreationOptions | undefined,
  origin: string,
): PasskeyCreateRequest | null {
  const pk = options?.publicKey;
  if (!pk || !pk.rp || !pk.user || !pk.challenge) return null;
  const params = (pk.pubKeyCredParams ?? []).map((p) => p.alg);
  if (params.length > 0 && !params.includes(-7)) return null;
  // A platform-only request is the site asking for the device's own
  // authenticator; the vault is cross-platform, so leave it to the browser.
  if (pk.authenticatorSelection?.authenticatorAttachment === "platform") return null;
  return {
    origin,
    cross_origin: false,
    rp: { id: pk.rp.id ?? hostOf(origin), name: pk.rp.name ?? "" },
    user: {
      id: toBase64Url(pk.user.id),
      name: pk.user.name ?? "",
      display_name: pk.user.displayName ?? "",
    },
    challenge: toBase64Url(pk.challenge),
    pub_key_cred_params: params,
    exclude_credentials: (pk.excludeCredentials ?? []).map((c) => toBase64Url(c.id)),
  };
}

export function requestOptionsToRequest(
  options: CredentialRequestOptions | undefined,
  origin: string,
): PasskeyGetRequest | null {
  const pk = options?.publicKey;
  if (!pk || !pk.challenge) return null;
  return {
    origin,
    cross_origin: false,
    rp_id: pk.rpId ?? hostOf(origin),
    challenge: toBase64Url(pk.challenge),
    allow_credentials: (pk.allowCredentials ?? []).map((c) => toBase64Url(c.id)),
  };
}

/**
 * The object a page receives in place of a `PublicKeyCredential`. A plain
 * object with the same shape and methods: relying-party libraries read the
 * fields and call the getters; none can construct the real class either.
 */
export function registrationToCredential(result: RegistrationResult) {
  const rawId = fromBase64Url(result.credential_id);
  const clientDataJSON = fromBase64Url(result.client_data_json);
  const attestationObject = fromBase64Url(result.attestation_object);
  const authenticatorData = fromBase64Url(result.authenticator_data);
  const publicKey = fromBase64Url(result.public_key);
  const response = {
    clientDataJSON,
    attestationObject,
    getAuthenticatorData: () => authenticatorData,
    getPublicKey: () => publicKey,
    getPublicKeyAlgorithm: () => result.public_key_algorithm,
    getTransports: () => ["hybrid", "internal"],
  };
  return {
    id: result.credential_id,
    rawId,
    type: "public-key",
    authenticatorAttachment: "cross-platform",
    response,
    getClientExtensionResults: () => ({ credProps: { rk: true } }),
    toJSON: () => ({
      id: result.credential_id,
      rawId: result.credential_id,
      type: "public-key",
      authenticatorAttachment: "cross-platform",
      clientExtensionResults: { credProps: { rk: true } },
      response: {
        clientDataJSON: result.client_data_json,
        attestationObject: result.attestation_object,
        authenticatorData: result.authenticator_data,
        publicKey: result.public_key,
        publicKeyAlgorithm: result.public_key_algorithm,
        transports: ["hybrid", "internal"],
      },
    }),
  };
}

export function assertionToCredential(result: AssertionResult) {
  const rawId = fromBase64Url(result.credential_id);
  const response = {
    clientDataJSON: fromBase64Url(result.client_data_json),
    authenticatorData: fromBase64Url(result.authenticator_data),
    signature: fromBase64Url(result.signature),
    userHandle: result.user_handle ? fromBase64Url(result.user_handle) : null,
  };
  return {
    id: result.credential_id,
    rawId,
    type: "public-key",
    authenticatorAttachment: "cross-platform",
    response,
    getClientExtensionResults: () => ({}),
    toJSON: () => ({
      id: result.credential_id,
      rawId: result.credential_id,
      type: "public-key",
      authenticatorAttachment: "cross-platform",
      clientExtensionResults: {},
      response: {
        clientDataJSON: result.client_data_json,
        authenticatorData: result.authenticator_data,
        signature: result.signature,
        userHandle: result.user_handle || null,
      },
    }),
  };
}

/** Messages between the page-world provider and the content-script bridge. */
export const PAGE_MESSAGE_SOURCE = "claspt-passkey";
export const BRIDGE_MESSAGE_SOURCE = "claspt-passkey-reply";

export interface PageRequest {
  source: typeof PAGE_MESSAGE_SOURCE;
  id: string;
  kind: "create" | "get";
  request: PasskeyCreateRequest | PasskeyGetRequest;
}

export interface BridgeReply {
  source: typeof BRIDGE_MESSAGE_SOURCE;
  id: string;
  /** "done" carries a result; "fallback" means let the browser handle it. */
  outcome: "done" | "fallback" | "error";
  result?: RegistrationResult | AssertionResult;
  error?: string;
}

/**
 * Whether a relying-party id may be used from a page on `hostname`.
 *
 * This is the WebAuthn rule, applied by us because the page cannot be trusted
 * to apply it: the RP ID must equal the page's host or be a registrable-domain
 * suffix of it. "login.github.com" may use "github.com"; "user.github.io" may
 * not use "github.io", because that is a public suffix shared by strangers;
 * and "evil-github.com" may not use "github.com" at all.
 *
 * Both the content script and the worker call this. The page-world request
 * used to be forwarded as sent, so any site could ask the vault to sign for
 * any other site and relay the answer, which is the one attack passkeys exist
 * to stop.
 */
export function rpIdAllowedForHost(hostname: string, rpId: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const rp = rpId.toLowerCase().replace(/\.$/, "");
  if (!host || !rp) return false;
  if (host === rp) return true;
  if (!host.endsWith("." + rp)) return false;
  // A suffix of the host is only acceptable if it still contains the host's
  // registrable domain: that is what rules out public suffixes.
  const registrable = getRegistrableDomain(host);
  return rp === registrable || rp.endsWith("." + registrable);
}

/**
 * The origin a passkey request is really coming from, or null if the URL is
 * not one a passkey may be used on.
 *
 * WebAuthn needs a secure context. Browsers treat https and the loopback
 * hosts as secure and nothing else, so the same set is accepted here. The
 * origin is computed, never read from the request, because the request came
 * from the page.
 */
export function passkeyOriginFrom(url: string | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback))
    return null;
  return parsed.origin;
}
