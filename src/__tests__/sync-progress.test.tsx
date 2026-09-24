// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { SyncProgressPanel } from "@/components/SyncProgressPanel";
import { useSyncStore } from "@/stores/sync-store";
import {
  FIX_STAGES,
  FRESH_COPY_STAGES,
  elapsedSeconds,
  megabytes,
  stageLabel,
} from "@/lib/sync-progress";

vi.mock("@/lib/commands", () => ({
  VAULT_IDENTITY_PROGRESS_EVENT: "vault-identity-progress",
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/stores/pages-store", () => ({
  usePagesStore: { getState: () => ({ openPage: vi.fn() }) },
}));
vi.mock("sonner", () => ({ toast: { warning: vi.fn() } }));

describe("sync progress wording", () => {
  it("labels every step and adds the size once known", () => {
    for (const stage of FIX_STAGES) {
      expect(stageLabel(stage, null)).not.toBe(stage);
    }
    expect(stageLabel("checking-password", null)).toBe("Checking your password");
    expect(stageLabel("uploading", 1_500_000)).toBe("Uploading the fresh copy (1.5 MB)");
    expect(stageLabel("uploading", null)).toBe("Uploading the fresh copy");
    expect(stageLabel("something-new", null)).toBe("something-new");
    expect(megabytes(38_400_000)).toBe("38.4 MB");
  });

  it("the fresh-copy steps are the tail of the fix's steps", () => {
    expect(FIX_STAGES.slice(-FRESH_COPY_STAGES.length)).toEqual([...FRESH_COPY_STAGES]);
  });

  it("counts whole seconds and never goes negative", () => {
    expect(elapsedSeconds(1_000, 13_900)).toBe(12);
    expect(elapsedSeconds(5_000, 1_000)).toBe(0);
  });
});

describe("SyncProgressPanel", () => {
  afterEach(cleanup);

  it("marks the current step, the ones before it, and shows the clock", () => {
    useSyncStore.setState({
      identityProgress: { stage: "uploading", bytes: 38_400_000 },
      identityStartedAt: Date.now() - 12_500,
    });

    render(<SyncProgressPanel stages={FRESH_COPY_STAGES} />);

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("✓Clearing the account's old copy");
    expect(status).toHaveTextContent("✓Packing this vault");
    expect(status).toHaveTextContent("…Uploading the fresh copy (38.4 MB)");
    expect(status).toHaveTextContent("·Recording the new version");
    expect(status).toHaveTextContent(/1[23] s so far/);
  });

  it("shows every step as pending before the first line arrives", () => {
    useSyncStore.setState({ identityProgress: null, identityStartedAt: Date.now() });

    render(<SyncProgressPanel stages={FRESH_COPY_STAGES} />);

    expect(screen.getByRole("status")).toHaveTextContent(
      "·Clearing the account's old copy",
    );
    expect(screen.getByRole("status")).toHaveTextContent("0 s so far");
  });
});
