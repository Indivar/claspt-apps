// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { describe, it, expect, vi } from "vitest";
import {
  flushGeneratedOutbox,
  parkGenerated,
  parkedGeneratedCount,
} from "@/background/generated-outbox";
import type { ApiClient } from "@/background/api-client";
import { HISTORY_FOLDER } from "@claspt/shared/generated-history";
import { resetHistoryPathCache } from "@/background/generated-history-store";

function api(patch: ReturnType<typeof vi.fn>): ApiClient {
  return {
    createPage: vi.fn(() => Promise.resolve({ path: `${HISTORY_FOLDER}/2026-09.md` })),
    listPages: vi.fn(() => Promise.resolve([])),
    patchSecretBlock: patch,
  } as unknown as ApiClient;
}

describe("generated-password outbox", () => {
  it("parks a value once and writes it when the vault is back", async () => {
    resetHistoryPathCache();
    await parkGenerated({ password: "p1", site: "a.test", generated: "2026-09-19T00:00:00Z" });
    await parkGenerated({ password: "p1", site: "a.test", generated: "2026-09-19T00:00:00Z" });
    await parkGenerated({ password: "p2", site: "b.test", generated: "2026-09-19T00:00:01Z" });
    expect(await parkedGeneratedCount()).toBe(2);

    const patch = vi.fn(() => Promise.resolve({ page: {}, etag: "v1" }));
    await flushGeneratedOutbox(api(patch));
    expect(patch).toHaveBeenCalledTimes(2);
    expect(await parkedGeneratedCount()).toBe(0);
  });

  it("keeps what still cannot be written", async () => {
    resetHistoryPathCache();
    await parkGenerated({ password: "p1", site: "a.test", generated: "2026-09-19T00:00:00Z" });
    const patch = vi.fn(() => Promise.reject(new Error("locked")));
    await flushGeneratedOutbox(api(patch));
    expect(await parkedGeneratedCount()).toBe(1);
  });
});
