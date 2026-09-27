// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { describe, expect, it } from "vitest";
import { bandFor } from "@/lib/at-rest";
import { canPersistDraft } from "@/lib/drafts";

describe("bandFor", () => {
  it("names the two states and nothing for a plain page", () => {
    expect(bandFor({ encrypted: false }, 0)).toBeNull();
    expect(bandFor({ encrypted: true }, 0)).toEqual({
      kind: "chosen",
      text: "Fully encrypted page. Notes and secrets alike are ciphertext on disk. Not in content search.",
      action: null,
    });
    expect(bandFor({ encrypted: true, auto_encrypted: true }, 3)).toEqual({
      kind: "automatic",
      text: "Stored encrypted while it holds 3 lines that look like credentials.",
      action: "Convert them to a secret",
    });
    expect(bandFor({ encrypted: true, auto_encrypted: true }, 1)?.text).toContain(
      "1 line that looks like a credential",
    );
  });
});

describe("canPersistDraft", () => {
  it("keeps a draft out of browser storage while the page holds a credential", () => {
    expect(canPersistDraft({ meta: { encrypted: false } }, false)).toBe(true);
    expect(canPersistDraft({ meta: { encrypted: false } }, true)).toBe(false);
    expect(canPersistDraft({ meta: { encrypted: true } }, false)).toBe(false);
  });
});
