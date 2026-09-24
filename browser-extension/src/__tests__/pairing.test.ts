// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestPairing } from "@/background/pairing";

function answer(status: number, body?: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), { status })),
  );
}

beforeEach(() => {
  vi.stubGlobal("chrome", {
    permissions: { contains: vi.fn(async () => true) },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("requestPairing", () => {
  it("returns the token when the pairing window is open", async () => {
    answer(200, { token: "clsp_token", scope: "secrets" });
    expect(await requestPairing(9315)).toEqual({ ok: true, token: "clsp_token", scope: "secrets" });
  });

  it("reads 403 as the window not being open", async () => {
    answer(403);
    expect(await requestPairing(9315)).toEqual({ ok: false, reason: "not-open" });
  });

  // A desktop from before pairing existed has no such route. Telling its owner
  // to press Connect sends them looking for a button their version never had.
  it("reads a missing pairing route as a desktop that is too old", async () => {
    answer(404);
    expect(await requestPairing(9315)).toEqual({ ok: false, reason: "desktop-too-old" });
  });

  it("reads a refused connection as unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    expect(await requestPairing(9315)).toEqual({ ok: false, reason: "unreachable" });
  });
});
