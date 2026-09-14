// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * embeds.ts — inline `<iframe>` embeds for a fixed set of trusted providers.
 *
 * Security-sensitive: only URLs whose origin is on {@link ALLOWED_ORIGINS}
 * (YouTube, Vimeo, Spotify, CodePen, etc.) are turned into iframes; anything else
 * is left as a plain link. This allowlist is the guard against arbitrary
 * third-party frames being embedded from note content.
 */
import type { MarkdownExtension } from "./types";
import { registerExtension } from "./registry";

/** Allowed embed origins (security allowlist). */
const ALLOWED_ORIGINS = [
  "https://www.youtube.com",
  "https://youtube.com",
  "https://player.vimeo.com",
  "https://open.spotify.com",
  "https://codepen.io",
  "https://codesandbox.io",
  "https://stackblitz.com",
  "https://www.google.com/maps",
  "https://maps.google.com",
  "https://gist.github.com",
];

/** Check if a URL is from an allowed origin. */
function isAllowedOrigin(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ALLOWED_ORIGINS.some((origin) => {
      const allowed = new URL(origin);
      return (
        parsed.hostname === allowed.hostname ||
        parsed.hostname.endsWith("." + allowed.hostname)
      );
    });
  } catch {
    return false;
  }
}

/** Encode a string for safe HTML attribute embedding. */
function encodeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** Embeds extension — @[type](url) syntax for sandboxed iframes. */
const embedsExtension: MarkdownExtension = {
  id: "embeds",
  name: "Embeds",
  description: "@[type](url) for sandboxed YouTube, Vimeo, etc.",
  category: "media",
  defaultEnabled: false,
  toolbarInsert: "@[youtube](https://www.youtube.com/watch?v=)",
  toolbarOrder: 80,
  iconPath:
    "M21 3H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H3V5h18v14zM10 8l6 4-6 4V8z",

  preprocess: (content: string) => {
    // Match @[type](url) pattern — not inside code blocks.
    //
    // Security: we deliberately do NOT emit a raw <iframe> here and we do NOT
    // add `iframe` to the DOMPurify allowlist. Emitting an iframe tag and
    // allowing it globally would let a raw `<iframe src="https://evil">`
    // written directly into note markdown bypass this origin check entirely
    // (the allowlist only runs on the @[..](..) syntax). Instead we emit an
    // inert placeholder carrying the vetted URL in a data attribute, and the
    // post-processor builds the sandboxed iframe from it. DOMPurify strips any
    // raw <iframe> the user typed because the tag is never allowlisted.
    return content.replace(
      /^@\[(\w+)\]\(([^)]+)\)$/gm,
      (_match, type: string, url: string) => {
        const trimmedUrl = url.trim();
        if (!isAllowedOrigin(trimmedUrl)) {
          return `<div class="embed-blocked"><span class="embed-blocked-icon">⚠</span> Embed blocked: origin not in allowlist</div>`;
        }

        const embedUrl = normalizeEmbedUrl(type, trimmedUrl);
        return `<div class="embed-block embed-${encodeAttr(type)}" data-embed-src="${encodeAttr(embedUrl)}"></div>`;
      },
    );
  },

  // Only the placeholder div + its data attribute need to survive sanitization.
  // `data-embed-src` is preserved via ALLOW_DATA_ATTR. No iframe is allowlisted.
  postprocess: (container: HTMLElement) => {
    const placeholders = container.querySelectorAll<HTMLElement>(
      ".embed-block[data-embed-src]",
    );
    for (const el of placeholders) {
      const src = el.getAttribute("data-embed-src");
      // Re-validate origin at injection time (defense in depth) — never trust
      // that only preprocess produced this node.
      if (!src || !isAllowedOrigin(src)) continue;
      if (el.querySelector("iframe")) continue; // already injected

      const iframe = document.createElement("iframe");
      iframe.src = src;
      iframe.className = "embed-iframe";
      // Force the sandbox/referrer policy here so it cannot be widened by
      // attacker-controlled markup.
      iframe.setAttribute("sandbox", "allow-scripts allow-popups");
      iframe.setAttribute(
        "allow",
        "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture",
      );
      iframe.setAttribute("referrerpolicy", "no-referrer");
      iframe.setAttribute("loading", "lazy");
      iframe.setAttribute("allowfullscreen", "");
      el.appendChild(iframe);
    }
    return undefined;
  },
};

/** Convert common video URLs to embeddable format. */
function normalizeEmbedUrl(type: string, url: string): string {
  if (type === "youtube" || type === "video") {
    // youtube.com/watch?v=ID → youtube.com/embed/ID
    const match = url.match(/(?:youtu\.be\/|youtube\.com\/watch\?v=)([\w-]+)/);
    if (match) return `https://www.youtube.com/embed/${match[1]}`;
    // Already an embed URL
    if (url.includes("/embed/")) return url;
  }
  if (type === "vimeo") {
    const match = url.match(/vimeo\.com\/(\d+)/);
    if (match) return `https://player.vimeo.com/video/${match[1]}`;
  }
  if (type === "spotify") {
    // Convert open.spotify.com/track/ID → open.spotify.com/embed/track/ID
    const match = url.match(/open\.spotify\.com\/(track|album|playlist)\/([\w]+)/);
    if (match) return `https://open.spotify.com/embed/${match[1]}/${match[2]}`;
  }
  return url;
}

registerExtension(embedsExtension);

export default embedsExtension;
