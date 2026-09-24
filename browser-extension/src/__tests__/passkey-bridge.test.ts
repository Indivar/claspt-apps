// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://shop.example.com/checkout" }

/**
 * The content-script side of the passkey path. The page can post any request
 * it likes with any origin and RP ID in it; the bridge must replace the origin
 * with the frame's own and refuse an RP ID the frame may not use, before
 * anything reaches the worker. This is the first of two independent gates.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { BRIDGE_MESSAGE_SOURCE, PAGE_MESSAGE_SOURCE } from "@/shared/passkey-codec";

type Sent = {
  type: string;
  request?: { origin?: string; rp_id?: string; rp?: { id: string } };
};

// The bridge registers its window listener once, at import. Importing it per
// test would stack listeners and every later test would see one reply per
// import, so it is loaded once and only the worker stub changes per test.
const sent: Sent[] = [];
const replies: { outcome?: string; id?: string }[] = [];
vi.stubGlobal("chrome", {
  runtime: {
    sendMessage: (message: Sent, cb: (r: unknown) => void) => {
      sent.push(message);
      cb({ type: "PASSKEY_RESULT", outcome: "done", result: { ok: true } });
    },
    getURL: () => "chrome-extension://x/p.js",
  },
});
window.addEventListener("message", (e: MessageEvent) => {
  const d = e.data as { source?: string; outcome?: string; id?: string };
  if (d?.source === BRIDGE_MESSAGE_SOURCE) replies.push(d);
});
await import("@/content/passkey-bridge");

/** Post a page-world request and collect what the bridge sends and replies. */
async function drive(request: unknown, kind: "get" | "create") {
  window.dispatchEvent(
    new MessageEvent("message", {
      source: window,
      origin: window.location.origin,
      data: { source: PAGE_MESSAGE_SOURCE, id: "req-1", kind, request },
    }),
  );
  await new Promise((r) => setTimeout(r, 20));
  return { sent, replies };
}

beforeEach(() => {
  sent.length = 0;
  replies.length = 0;
});

describe("passkey bridge refuses to act for another site", () => {
  it("drops a get for a foreign RP ID without contacting the worker", async () => {
    // evil site asks the vault to sign for github.com and relay it.
    const { sent, replies } = await drive(
      {
        origin: "https://github.com",
        cross_origin: false,
        rp_id: "github.com",
        challenge: "AAAA",
        allow_credentials: [],
      },
      "get",
    );
    expect(sent).toHaveLength(0);
    expect(replies.map((r) => r.outcome)).toEqual(["fallback"]);
  });

  it("drops a create for a foreign RP ID without contacting the worker", async () => {
    const { sent, replies } = await drive(
      {
        origin: "https://github.com",
        cross_origin: false,
        rp: { id: "github.com", name: "GitHub" },
        user: {},
        challenge: "AAAA",
        pub_key_cred_params: [],
      },
      "create",
    );
    expect(sent).toHaveLength(0);
    expect(replies.map((r) => r.outcome)).toEqual(["fallback"]);
  });

  it("drops a request with no RP ID at all", async () => {
    const { sent, replies } = await drive(
      { origin: "https://shop.example.com", challenge: "AAAA" },
      "get",
    );
    expect(sent).toHaveLength(0);
    expect(replies.map((r) => r.outcome)).toEqual(["fallback"]);
  });
});

describe("passkey bridge rewrites what it does forward", () => {
  it("replaces a lying origin with the frame's own and keeps a valid RP ID", async () => {
    const { sent } = await drive(
      {
        origin: "https://attacker.example",
        cross_origin: true,
        rp_id: "example.com",
        challenge: "AAAA",
        allow_credentials: [],
      },
      "get",
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.type).toBe("PASSKEY_GET");
    expect(sent[0]?.request?.origin).toBe("https://shop.example.com");
    expect(sent[0]?.request?.rp_id).toBe("example.com");
  });

  it("does the same for create", async () => {
    const { sent } = await drive(
      {
        origin: "https://attacker.example",
        cross_origin: true,
        rp: { id: "shop.example.com", name: "Shop" },
        user: {},
        challenge: "AAAA",
        pub_key_cred_params: [],
      },
      "create",
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.type).toBe("PASSKEY_CREATE");
    expect(sent[0]?.request?.origin).toBe("https://shop.example.com");
    expect(sent[0]?.request?.rp?.id).toBe("shop.example.com");
  });
});
