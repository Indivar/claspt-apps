// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { describe, it, expect } from "vitest";
import {
  altFromName,
  attachmentDisplayName,
  attachmentMarkdown,
  attachmentRefs,
  checkAttachmentSize,
  encryptionNote,
  extForMime,
  extOf,
  formatSize,
  isAttachmentExt,
  isRaster,
  limitBytes,
  MAX_ATTACHMENT_MB,
  removeAttachmentReferences,
} from "@/lib/attachments";

const MIB = 1024 * 1024;

describe("attachment size rules", () => {
  it("clamps the vault limit to what Claspt allows", () => {
    expect(limitBytes(undefined)).toBe(5 * MIB);
    expect(limitBytes(0)).toBe(1 * MIB);
    expect(limitBytes(99)).toBe(MAX_ATTACHMENT_MB * MIB);
    expect(limitBytes(12)).toBe(12 * MIB);
  });

  it("accepts a file within the limit and refuses one over it with both numbers", () => {
    expect(checkAttachmentSize(5 * MIB, 5, "png")).toEqual({ over: false });
    const check = checkAttachmentSize(7.3 * MIB, 5, "png");
    expect(check).toEqual({
      over: true,
      sizeMb: 7.3,
      limitMb: 5,
      raiseTo: 8,
      canShrink: true,
    });
  });

  it("offers to raise the limit only up to the ceiling, and shrinking only for images", () => {
    const pdf = checkAttachmentSize(6 * MIB, 5, "pdf");
    expect(pdf).toMatchObject({ over: true, raiseTo: 6, canShrink: false });
    const huge = checkAttachmentSize(30 * MIB, 5, "jpg");
    expect(huge).toMatchObject({ over: true, raiseTo: null, canShrink: true });
  });

  it("knows which types can be resized", () => {
    expect(isRaster("PNG")).toBe(true);
    expect(isRaster("svg")).toBe(false);
    expect(isRaster("pdf")).toBe(false);
  });
});

describe("attachment text", () => {
  it("formats sizes for a sentence", () => {
    expect(formatSize(800)).toBe("800 B");
    expect(formatSize(120.5 * 1024)).toBe("120.5 KB");
    expect(formatSize(7.3 * MIB)).toBe("7.3 MB");
  });

  it("says plainly what the encrypt box does in each state", () => {
    expect(encryptionNote(false)).toContain(
      "can be read from the vault folder in Finder",
    );
    expect(encryptionNote(true)).toContain("opens only inside Claspt");
  });

  it("builds a markdown reference that cannot break out of its brackets", () => {
    expect(attachmentMarkdown("photo", "_media/ab12.png")).toBe(
      "![photo](_media/ab12.png)",
    );
    expect(attachmentMarkdown("a]b[c\n", "_media/x.png")).toBe("![a b c](_media/x.png)");
    expect(attachmentMarkdown("   ", "_media/x.png")).toBe("![attachment](_media/x.png)");
  });

  it("derives a display name and an extension from a file name", () => {
    expect(altFromName("pictures/2026/holiday.JPG")).toBe("holiday");
    expect(altFromName("C:\\Pictures\\holiday.JPG")).toBe("holiday");
    expect(altFromName("report.v2.pdf")).toBe("report.v2");
    expect(extOf("report.v2.PDF")).toBe("pdf");
    expect(extOf("noext")).toBe("");
  });
});

describe("attachment references", () => {
  it("removes the reference and the line it stood alone on", () => {
    const page = "# Title\n\n![shot](_media/ab12.png)\n\nText after.\n";
    expect(removeAttachmentReferences(page, "_media/ab12.png")).toBe(
      "# Title\n\n\nText after.\n",
    );
  });

  it("keeps other text on a shared line and leaves other attachments alone", () => {
    const page = "See ![a](_media/a.png) and ![b](_media/b.png) here\n![a](_media/a.png)";
    expect(removeAttachmentReferences(page, "_media/a.png")).toBe(
      "See  and ![b](_media/b.png) here",
    );
  });

  it("treats the path literally, so a dot does not match any character", () => {
    const page = "![x](_media/axb.png)\n![y](_media/a.b.png)\n";
    expect(removeAttachmentReferences(page, "_media/a.b.png")).toBe(
      "![x](_media/axb.png)\n",
    );
  });
});

describe("attachment types", () => {
  it("maps clipboard types to extensions and knows what can be attached", () => {
    expect(extForMime("image/jpeg")).toBe("jpg");
    expect(extForMime("application/pdf")).toBe("pdf");
    expect(extForMime("text/plain")).toBe("");
    expect(isAttachmentExt("PDF")).toBe(true);
    expect(isAttachmentExt("exe")).toBe(false);
  });
});

describe("attachment references with a comment", () => {
  it("keeps the comment in the link's title, cleaned and escaped", () => {
    expect(attachmentMarkdown("Scan", "_media/a.pdf")).toBe("![Scan](_media/a.pdf)");
    expect(attachmentMarkdown("Scan", "_media/a.pdf", "  ")).toBe(
      "![Scan](_media/a.pdf)",
    );
    expect(attachmentMarkdown("Scan", "_media/a.pdf", "from the clinic")).toBe(
      '![Scan](_media/a.pdf "from the clinic")',
    );
    expect(attachmentMarkdown("Scan", "_media/a.pdf", 'say "hi"\nnow')).toBe(
      '![Scan](_media/a.pdf "say \\"hi\\" now")',
    );
  });

  it("still finds and removes a reference that carries a comment", () => {
    const page =
      'before\n![Scan](_media/a.pdf "from the clinic")\nafter ![b](_media/b.png)\n';
    expect(attachmentRefs(page)).toEqual(["_media/a.pdf", "_media/b.png"]);
    expect(removeAttachmentReferences(page, "_media/a.pdf")).toBe(
      "before\nafter ![b](_media/b.png)\n",
    );
    // A comment with an escaped quote does not confuse the removal.
    const tricky = '![Scan](_media/a.pdf "say \\"hi\\"") kept\n';
    expect(removeAttachmentReferences(tricky, "_media/a.pdf")).toBe(" kept\n");
  });

  it("shows the original name, never the stored one, when the alt is there", () => {
    expect(
      attachmentDisplayName("DocScanner 7 Sept", "9ff017068b9e9083.pdf", "pdf"),
    ).toBe("DocScanner 7 Sept.pdf");
    expect(attachmentDisplayName("photo.JPG", "01be9e.jpg", "jpg")).toBe("photo.JPG");
    expect(attachmentDisplayName("", "9ff017068b9e9083.pdf", "pdf")).toBe(
      "9ff017068b9e9083.pdf",
    );
    expect(attachmentDisplayName(undefined, "x.png", "png")).toBe("x.png");
  });
});
