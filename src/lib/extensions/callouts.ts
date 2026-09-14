// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * callouts.ts — admonition/callout blocks (`> [!note]`, `> [!warning]`, …).
 *
 * A Marked renderer override that detects the `[!type]` marker on the first line
 * of a blockquote and renders a styled callout card (icon + title + body);
 * non-callout blockquotes fall through to default rendering. Pure HTML output,
 * no external library, so no lazy `load` is needed.
 */
import type { MarkedExtension, Tokens } from "marked";
import type { MarkdownExtension } from "./types";
import { registerExtension } from "./registry";
import { encodeAttr } from "./preview-pipeline";

/** Callout type metadata: color and SVG icon path. */
const CALLOUT_TYPES: Record<
  string,
  { color: string; darkColor: string; iconPath: string }
> = {
  note: {
    color: "#448aff",
    darkColor: "#448aff",
    iconPath:
      "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z",
  },
  tip: {
    color: "#00c853",
    darkColor: "#69f0ae",
    iconPath:
      "M9 21c0 .5.4 1 1 1h4c.6 0 1-.5 1-1v-1H9v1zm3-19C8.1 2 5 5.1 5 9c0 2.4 1.2 4.5 3 5.7V17c0 .5.4 1 1 1h6c.6 0 1-.5 1-1v-2.3c1.8-1.3 3-3.4 3-5.7 0-3.9-3.1-7-7-7z",
  },
  warning: {
    color: "#ff9100",
    darkColor: "#ffab40",
    iconPath: "M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z",
  },
  danger: {
    color: "#ff1744",
    darkColor: "#ff5252",
    iconPath:
      "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z",
  },
  info: {
    color: "#448aff",
    darkColor: "#448aff",
    iconPath:
      "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z",
  },
  success: {
    color: "#00c853",
    darkColor: "#69f0ae",
    iconPath:
      "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z",
  },
  question: {
    color: "#aa00ff",
    darkColor: "#d500f9",
    iconPath:
      "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75l-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25z",
  },
  quote: {
    color: "#78909c",
    darkColor: "#90a4ae",
    iconPath: "M6 17h3l2-4V7H5v6h3zm8 0h3l2-4V7h-6v6h3z",
  },
  example: {
    color: "#aa00ff",
    darkColor: "#d500f9",
    iconPath:
      "M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z",
  },
  bug: {
    color: "#ff1744",
    darkColor: "#ff5252",
    iconPath:
      "M20 8h-2.81c-.45-.78-1.07-1.45-1.82-1.96L17 4.41 15.59 3l-2.17 2.17C12.96 5.06 12.49 5 12 5c-.49 0-.96.06-1.41.17L8.41 3 7 4.41l1.62 1.63C7.88 6.55 7.26 7.22 6.81 8H4v2h2.09c-.05.33-.09.66-.09 1v1H4v2h2v1c0 .34.04.67.09 1H4v2h2.81c1.04 1.79 2.97 3 5.19 3s4.15-1.21 5.19-3H20v-2h-2.09c.05-.33.09-.66.09-1v-1h2v-2h-2v-1c0-.34-.04-.67-.09-1H20V8zm-6 8h-4v-2h4v2zm0-4h-4v-2h4v2z",
  },
};

/** Create a Marked extension that transforms blockquotes with [!type] into callouts. */
function markedCallouts(): MarkedExtension {
  return {
    renderer: {
      blockquote(token: Tokens.Blockquote) {
        // Get the raw body text — check first child for [!type] pattern
        const body = token.text;
        const match = body.match(
          /^\s*\[!(note|tip|warning|danger|info|success|question|quote|example|bug)\](?:\s+([^\n]+))?\n?([\s\S]*)/i,
        );

        if (!match) {
          // Not a callout, render as normal blockquote
          return false;
        }

        const type = match[1]!.toLowerCase();
        const title = match[2] || type.charAt(0).toUpperCase() + type.slice(1);
        const bodyContent = match[3] || "";
        const meta = CALLOUT_TYPES[type] || CALLOUT_TYPES.note!;

        // Render the body content through the parser for nested markdown
        const parsedBody = bodyContent.trim()
          ? `<div class="callout-body">${bodyContent}</div>`
          : "";

        const safeType = encodeAttr(type);
        const safeTitle = encodeAttr(title);

        return `<div class="callout callout-${safeType}" data-callout-type="${safeType}">
  <div class="callout-header">
    <svg class="callout-icon" viewBox="0 0 24 24" width="18" height="18" fill="currentColor" style="color:${meta.color}">
      <path d="${meta.iconPath}"/>
    </svg>
    <span class="callout-title">${safeTitle}</span>
  </div>
  ${parsedBody}
</div>`;
      },
    },
  };
}

/** Callouts extension definition. */
const calloutsExtension: MarkdownExtension = {
  id: "callouts",
  name: "Callouts",
  description: "> [!note], > [!warning], > [!tip] styled blocks",
  category: "core",
  defaultEnabled: true,
  toolbarInsert: "> [!note]\n> ",
  toolbarOrder: 50,
  iconPath:
    "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z",
  markedExtension: () => markedCallouts(),
};

registerExtension(calloutsExtension);

export default calloutsExtension;
