// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { describe, it, expect } from "vitest";
import { actionBadge, actionTitle, iconTreatment } from "@/background/action-state";

describe("the toolbar icon says what the extension can do", () => {
  it("names the problem in the hover text for every state that is not connected", () => {
    expect(actionTitle({ state: "disconnected", matches: 0, waiting: 0 })).toContain(
      "not running",
    );
    expect(actionTitle({ state: "vault_locked", matches: 0, waiting: 0 })).toContain(
      "locked",
    );
    expect(actionTitle({ state: "extension_locked", matches: 0, waiting: 0 })).toContain(
      "Click to unlock",
    );
    expect(actionTitle({ state: "permission_needed", matches: 0, waiting: 0 })).toContain(
      "permission",
    );
    expect(actionTitle({ state: "desktop_too_old", matches: 0, waiting: 0 })).toContain(
      "Update the app",
    );
  });

  it("says to pair again when the app refuses the key", () => {
    expect(actionTitle({ state: "unauthorized", matches: 0, waiting: 0 })).toContain("Pair again");
    expect(actionBadge({ state: "unauthorized", matches: 0, waiting: 0 }).text).toBe("!");
    expect(iconTreatment("unauthorized")).toBe("dimmed");
  });

  it("counts the site's logins and what is waiting when connected", () => {
    expect(actionTitle({ state: "connected", matches: 3, waiting: 0 })).toBe(
      "Claspt: 3 logins for this site",
    );
    expect(actionTitle({ state: "connected", matches: 1, waiting: 1 })).toBe(
      "Claspt: 1 login for this site\n1 login waiting to be saved",
    );
    expect(actionTitle({ state: "disconnected", matches: 0, waiting: 2 })).toContain(
      "2 logins waiting",
    );
  });

  it("shows the match count first, the waiting count when there is no match, and marks otherwise", () => {
    expect(actionBadge({ state: "connected", matches: 3, waiting: 2 }).text).toBe("3");
    expect(actionBadge({ state: "connected", matches: 0, waiting: 2 }).text).toBe("2");
    expect(actionBadge({ state: "connected", matches: 0, waiting: 0 }).text).toBe("");
    expect(actionBadge({ state: "disconnected", matches: 0, waiting: 2 }).text).toBe("X");
    expect(actionBadge({ state: "vault_locked", matches: 0, waiting: 0 }).text).toBe("!");
  });

  it("dims the icon whenever it cannot fill", () => {
    expect(iconTreatment("connected")).toBe("normal");
    expect(iconTreatment("disconnected")).toBe("dimmed");
    expect(iconTreatment("vault_locked")).toBe("dimmed");
  });
});
