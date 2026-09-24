// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { describe, expect, it } from "vitest";
import { connectionFromStatus } from "@/popup/connection";

const base = { type: "STATUS_RESULT" as const, connected: false, vaultUnlocked: false };

describe("connectionFromStatus", () => {
  it("asks for the local permission before anything else", () => {
    expect(connectionFromStatus({ ...base, permissionNeeded: true, desktopTooOld: true })).toBe("permission_needed");
  });

  it("says the desktop is too old rather than merely disconnected", () => {
    expect(connectionFromStatus({ ...base, desktopTooOld: true, version: "3.0.6" })).toBe("desktop_too_old");
  });

  it("is connected when the background says so", () => {
    expect(connectionFromStatus({ ...base, connected: true, vaultUnlocked: true })).toBe("connected");
  });

  it("is disconnected when nothing answers", () => {
    expect(connectionFromStatus(base)).toBe("disconnected");
  });
});
