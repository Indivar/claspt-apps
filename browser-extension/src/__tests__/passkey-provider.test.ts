// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * The page-world provider replaces `navigator.credentials.create` and `.get`
 * on every site the person visits. The dangerous failure is not that a passkey
 * does not work; it is that a request Claspt should not have touched never
 * reaches the browser, and a site that worked before stops working with no
 * explanation. These tests are mostly about falling through correctly.
 *
 * The cryptography and the real WebAuthn dialog are not exercised here. That
 * needs a real browser with a virtual authenticator against a real relying
 * party, and is a manual check against webauthn.io.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { BRIDGE_MESSAGE_SOURCE, PAGE_MESSAGE_SOURCE } from "@/shared/passkey-codec";

/** A minimal creation request of the shape a site actually sends. */
function creationOptions(): CredentialCreationOptions {
  return {
    publicKey: {
      rp: { id: "example.com", name: "Example" },
      user: {
        id: new Uint8Array([1, 2, 3]),
        name: "me@example.com",
        displayName: "Me",
      },
      challenge: new Uint8Array([9, 9, 9]),
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    },
  } as CredentialCreationOptions;
}

/**
 * Load the provider fresh against a stubbed `navigator.credentials`, and
 * answer its first outgoing message with `reply`.
 */
async function withProvider(reply: (id: string) => unknown | null) {
  const originalCreate = vi.fn().mockResolvedValue({ from: "browser" });
  const originalGet = vi.fn().mockResolvedValue({ from: "browser" });
  Object.defineProperty(navigator, "credentials", {
    configurable: true,
    value: { create: originalCreate, get: originalGet },
  });

  const seen: unknown[] = [];
  const listener = (event: MessageEvent) => {
    const data = event.data as { source?: string; id?: string } | undefined;
    if (data?.source !== PAGE_MESSAGE_SOURCE || !data.id) return;
    seen.push(data);
    const answer = reply(data.id);
    // A real same-window postMessage arrives with `source === window`, which
    // is what the provider checks. jsdom's postMessage leaves source null, so
    // the event is built by hand rather than testing jsdom's gap.
    if (answer) {
      setTimeout(
        () => window.dispatchEvent(new MessageEvent("message", { data: answer, source: window })),
        0,
      );
    }
  };
  window.addEventListener("message", listener);
  // Left attached, an earlier test's stub answers a later test's request and
  // the provider takes whichever reply arrives first.
  listeners.push(listener);

  vi.resetModules();
  await import("@/page/passkey-provider");
  return { originalCreate, originalGet, seen };
}

const listeners: ((event: MessageEvent) => void)[] = [];

afterEach(() => {
  for (const listener of listeners.splice(0)) {
    window.removeEventListener("message", listener);
  }
});

beforeEach(() => {
  if (!("randomUUID" in crypto)) {
    Object.defineProperty(crypto, "randomUUID", {
      configurable: true,
      value: () => "00000000-0000-4000-8000-000000000000",
    });
  }
});

describe("the provider installs itself", () => {
  it("wraps create and get, and marks itself so a second copy is a no-op", async () => {
    const { originalCreate } = await withProvider(() => null);
    expect(navigator.credentials.create).not.toBe(originalCreate);

    const wrapped = navigator.credentials.create;
    vi.resetModules();
    await import("@/page/passkey-provider");
    // Injecting twice must not double-wrap: each layer adds a timeout.
    expect(navigator.credentials.create).toBe(wrapped);
  });
});

describe("requests that are not ours go to the browser untouched", () => {
  it("passes through a create with no publicKey", async () => {
    const { originalCreate, seen } = await withProvider(() => null);
    await navigator.credentials.create({} as CredentialCreationOptions);
    expect(originalCreate).toHaveBeenCalledOnce();
    expect(seen).toHaveLength(0);
  });

  it("passes through an already-aborted create without asking the vault", async () => {
    const { originalCreate, seen } = await withProvider(() => null);
    const controller = new AbortController();
    controller.abort();
    await navigator.credentials.create({
      ...creationOptions(),
      signal: controller.signal,
    } as CredentialCreationOptions);
    expect(originalCreate).toHaveBeenCalledOnce();
    expect(seen).toHaveLength(0);
  });

  it("leaves conditional mediation to the browser, which owns autofill", async () => {
    const { originalGet, seen } = await withProvider(() => null);
    await navigator.credentials.get({
      publicKey: { challenge: new Uint8Array([1]) },
      mediation: "conditional",
    } as CredentialRequestOptions);
    expect(originalGet).toHaveBeenCalledOnce();
    expect(seen).toHaveLength(0);
  });
});

describe("what the vault is asked", () => {
  it("sends one create request carrying the relying party and user", async () => {
    const { seen } = await withProvider((id) => ({
      source: BRIDGE_MESSAGE_SOURCE,
      id,
      outcome: "fallback",
    }));
    await navigator.credentials.create(creationOptions());

    expect(seen).toHaveLength(1);
    const sent = seen[0] as { kind: string; request: { rp: { id: string } } };
    expect(sent.kind).toBe("create");
    expect(sent.request.rp.id).toBe("example.com");
  });
});

describe("what the vault answers", () => {
  it("falls back to the browser when the vault declines", async () => {
    // A vault with no matching credential must not break the sign-in: the
    // browser's own authenticator still gets its turn.
    const { originalCreate } = await withProvider((id) => ({
      source: BRIDGE_MESSAGE_SOURCE,
      id,
      outcome: "fallback",
    }));
    const result = await navigator.credentials.create(creationOptions());
    expect(originalCreate).toHaveBeenCalledOnce();
    expect(result).toEqual({ from: "browser" });
  });

  it("raises NotAllowedError when the vault reports a failure", async () => {
    // Falling through on a real error would show the browser's own dialog
    // straight after ours, which reads as the site asking twice.
    const { originalCreate } = await withProvider((id) => ({
      source: BRIDGE_MESSAGE_SOURCE,
      id,
      outcome: "error",
      error: "vault is locked",
    }));
    await expect(navigator.credentials.create(creationOptions())).rejects.toThrow(
      /vault is locked/,
    );
    expect(originalCreate).not.toHaveBeenCalled();
  });

  it("ignores a reply whose id does not match the request", async () => {
    // Any script on the page can post a message. Answering one that does not
    // carry our id would let a page forge a registration.
    const { originalCreate } = await withProvider(() => ({
      source: BRIDGE_MESSAGE_SOURCE,
      id: "not-the-id-we-sent",
      outcome: "error",
      error: "forged",
    }));
    const pending = navigator.credentials.create(creationOptions());
    await new Promise((r) => setTimeout(r, 10));
    // Still waiting, not rejected by the forged reply.
    await expect(Promise.race([pending, Promise.resolve("pending")])).resolves.toBe(
      "pending",
    );
    expect(originalCreate).not.toHaveBeenCalled();
  });
});
