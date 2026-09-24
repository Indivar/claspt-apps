// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { describe, it, expect } from "vitest";
import { attachmentAt, showChip, showImage } from "@/lib/preview-attachments";
import type { MediaRead } from "@/lib/commands";

function read(over: Partial<MediaRead> = {}): MediaRead {
  return {
    data_url: "data:image/png;base64,AAAA",
    sealed: false,
    size: 2048,
    name: "ab12.png",
    ext: "png",
    rel_path: "general/_media/ab12.png",
    md_path: "_media/ab12.png",
    ...over,
  };
}

/** A rendered `![alt](src "title")`, built the way marked would, without innerHTML. */
function renderedImage(attrs: { src?: string; alt?: string; title?: string } = {}): {
  root: HTMLDivElement;
  img: HTMLImageElement;
} {
  const root = document.createElement("div");
  const p = document.createElement("p");
  const img = document.createElement("img");
  img.setAttribute("src", attrs.src ?? "_media/ab12.png");
  img.setAttribute("alt", attrs.alt ?? "shot");
  if (attrs.title !== undefined) img.setAttribute("title", attrs.title);
  p.appendChild(img);
  root.appendChild(p);
  return { root, img };
}

describe("attachments in the rendered page", () => {
  it("shows a plain image from its bytes with no badge, and undoes cleanly", () => {
    const { root, img } = renderedImage();
    const undo = showImage(img, read());
    expect(img.src).toBe("data:image/png;base64,AAAA");
    expect(root.querySelector(".claspt-attachment-lock")).toBeNull();
    expect(attachmentAt(img)).toEqual({
      relPath: "general/_media/ab12.png",
      mdPath: "_media/ab12.png",
      sealed: false,
      name: "shot.png",
      size: 2048,
      ext: "png",
    });
    undo();
    expect(img.getAttribute("src")).toBe("_media/ab12.png");
    expect(attachmentAt(img)).toBeNull();
  });

  it("badges a sealed image and puts the image back on undo", () => {
    const { root, img } = renderedImage();
    const undo = showImage(img, read({ sealed: true }));
    const wrapper = root.querySelector(".claspt-attachment");
    expect(wrapper).not.toBeNull();
    expect(wrapper?.contains(img)).toBe(true);
    expect(root.querySelector(".claspt-attachment-lock")?.textContent).toBe("Encrypted");
    expect(attachmentAt(root.querySelector(".claspt-attachment-lock"))?.sealed).toBe(
      true,
    );
    undo();
    expect(root.querySelector(".claspt-attachment")).toBeNull();
    expect(root.querySelector("p")?.contains(img)).toBe(true);
  });

  it("never renders a PDF inline: the image becomes a chip with name and size", () => {
    const { root, img } = renderedImage();
    const pdf = read({
      data_url: "",
      name: "report.pdf",
      ext: "pdf",
      size: 3 * 1024 * 1024,
      sealed: true,
    });
    const undo = showChip(img, pdf);
    expect(root.querySelector("img")).toBeNull();
    const chip = root.querySelector(".claspt-attachment-chip");
    // The alt is the original name; the stored name is never shown.
    expect(chip?.querySelector(".claspt-attachment-name")?.textContent).toBe("shot.pdf");
    expect(chip?.querySelector(".claspt-attachment-size")?.textContent).toBe(
      "PDF · 3.0 MB",
    );
    expect(chip?.querySelector(".claspt-attachment-lock-inline")).not.toBeNull();
    expect(attachmentAt(chip?.firstChild ?? null)?.name).toBe("shot.pdf");
    undo();
    expect(root.querySelector(".claspt-attachment-chip")).toBeNull();
    expect(root.querySelector("img")).toBe(img);
  });

  it("ignores a right-click that is not on an attachment", () => {
    const { root } = renderedImage();
    expect(attachmentAt(root.querySelector("p"))).toBeNull();
    expect(attachmentAt(null)).toBeNull();
  });
});

describe("what the reference says about the file", () => {
  it("names a PDF chip by its original name and shows the comment under it", () => {
    const { root, img } = renderedImage({
      src: "_media/9ff0.pdf",
      alt: "DocScanner 7 Sept",
      title: "from the clinic",
    });
    const undo = showChip(
      img,
      read({ name: "9ff0.pdf", ext: "pdf", md_path: "_media/9ff0.pdf" }),
    );

    expect(root.querySelector(".claspt-attachment-name")?.textContent).toBe(
      "DocScanner 7 Sept.pdf",
    );
    expect(root.querySelector(".claspt-attachment-caption")?.textContent).toBe(
      "from the clinic",
    );
    const target = attachmentAt(root.querySelector(".claspt-attachment-caption"));
    expect(target?.name).toBe("DocScanner 7 Sept.pdf");
    expect(target?.mdPath).toBe("_media/9ff0.pdf");

    undo();
    expect(root.querySelector("img")?.getAttribute("title")).toBe("from the clinic");
  });

  it("tells an image by its original name and keeps the comment through an undo", () => {
    const { root, img } = renderedImage({ alt: "IMG_2026", title: "the meter" });
    const undo = showImage(img, read());

    expect(img.title).toContain("IMG_2026.png");
    expect(root.querySelector(".claspt-attachment-caption")?.textContent).toBe(
      "the meter",
    );

    undo();
    expect(img.getAttribute("title")).toBe("the meter");
    expect(root.querySelector(".claspt-attachment-caption")).toBeNull();
  });

  it("falls back to the stored name when the reference has no alt", () => {
    const { root, img } = renderedImage({ alt: "" });
    showChip(img, read({ name: "ab12.pdf", ext: "pdf" }));
    expect(root.querySelector(".claspt-attachment-name")?.textContent).toBe("ab12.pdf");
  });
});
