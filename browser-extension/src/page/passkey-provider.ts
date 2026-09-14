// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Page-world passkey provider. Injected by the content-script bridge before
 * page scripts run, it wraps `navigator.credentials.create` and `.get`:
 * public-key requests go to the vault through the bridge; anything the
 * vault does not handle (no credential, the user declined, a platform-only
 * request) falls through to the browser's own implementation, so nothing
 * that worked before stops working.
 */
import {
  BRIDGE_MESSAGE_SOURCE,
  PAGE_MESSAGE_SOURCE,
  assertionToCredential,
  creationOptionsToRequest,
  registrationToCredential,
  requestOptionsToRequest,
  type AssertionResult,
  type BridgeReply,
  type PageRequest,
  type RegistrationResult,
} from "@/shared/passkey-codec";

const TIMEOUT_MS = 120_000;

function ask(
  kind: PageRequest["kind"],
  request: PageRequest["request"],
): Promise<BridgeReply> {
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      resolve({ source: BRIDGE_MESSAGE_SOURCE, id, outcome: "fallback" });
    }, TIMEOUT_MS);
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window) return;
      const data = event.data as BridgeReply | undefined;
      if (!data || data.source !== BRIDGE_MESSAGE_SOURCE || data.id !== id) return;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve(data);
    };
    window.addEventListener("message", onMessage);
    const message: PageRequest = { source: PAGE_MESSAGE_SOURCE, id, kind, request };
    window.postMessage(message, window.location.origin);
  });
}

function install() {
  const credentials = navigator.credentials;
  if (!credentials || (credentials as { __claspt?: boolean }).__claspt) return;
  const originalCreate = credentials.create.bind(credentials);
  const originalGet = credentials.get.bind(credentials);

  credentials.create = async function (options?: CredentialCreationOptions) {
    const request = creationOptionsToRequest(options, window.location.origin);
    if (!request || options?.signal?.aborted) return originalCreate(options);
    const reply = await ask("create", request);
    if (reply.outcome === "done" && reply.result) {
      return registrationToCredential(
        reply.result as RegistrationResult,
      ) as unknown as Credential;
    }
    if (reply.outcome === "error") {
      throw new DOMException(
        reply.error ?? "passkey registration failed",
        "NotAllowedError",
      );
    }
    return originalCreate(options);
  };

  credentials.get = async function (options?: CredentialRequestOptions) {
    const request = requestOptionsToRequest(options, window.location.origin);
    // Conditional-mediation requests are the browser's autofill hook; the
    // vault has no UI there, so they stay with the browser.
    if (!request || options?.mediation === "conditional" || options?.signal?.aborted) {
      return originalGet(options);
    }
    const reply = await ask("get", request);
    if (reply.outcome === "done" && reply.result) {
      return assertionToCredential(
        reply.result as AssertionResult,
      ) as unknown as Credential;
    }
    if (reply.outcome === "error") {
      throw new DOMException(reply.error ?? "passkey sign-in failed", "NotAllowedError");
    }
    return originalGet(options);
  };

  (credentials as { __claspt?: boolean }).__claspt = true;
}

install();
