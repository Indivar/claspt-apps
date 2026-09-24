// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { describe, it, expect, vi } from "vitest";
import { HealthCheck } from "@/background/health-check";
import { ApiError, type ApiClient } from "@/background/api-client";

function withStatus(impl: () => Promise<unknown>): HealthCheck {
  const api = { getStatus: vi.fn(impl) } as unknown as ApiClient;
  return new HealthCheck(api);
}

describe("what a health check concludes", () => {
  it("is connected or vault-locked from an answer", async () => {
    expect(
      await withStatus(async () => ({ vault_unlocked: true, version: "4.0.54" })).check(),
    ).toBe("connected");
    expect(await withStatus(async () => ({ vault_unlocked: false })).check()).toBe(
      "vault_locked",
    );
  });

  it("tells a refused token apart from an app that is not there", async () => {
    const refused = withStatus(async () => {
      throw new ApiError(401, "UNAUTHORIZED", "Invalid token");
    });
    expect(await refused.check()).toBe("unauthorized");

    const away = withStatus(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await away.check()).toBe("disconnected");

    const other = withStatus(async () => {
      throw new ApiError(500, "INTERNAL_ERROR", "boom");
    });
    expect(await other.check()).toBe("disconnected");
  });
});
