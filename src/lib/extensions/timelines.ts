// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * timelines.ts — interactive timelines from ```timeline fenced blocks.
 *
 * The block body is a YAML-ish list of dated entries; the post-processor
 * lazy-loads vis-timeline + vis-data and mounts an interactive timeline widget
 * into the placeholder container.
 */
import type { MarkedExtension, Tokens } from "marked";
import type { MarkdownExtension } from "./types";
import { registerExtension } from "./registry";
import { encodeSource, decodeSource } from "./preview-pipeline";

/** Cached vis-timeline module references. */
let timelineMod: typeof import("vis-timeline/standalone") | null = null;
let dataSetMod: typeof import("vis-data") | null = null;

/** Counter for unique timeline container IDs. */
let idCounter = 0;

/**
 * Parse timeline YAML-like syntax:
 * ```timeline
 * - date: 2024-01-15
 *   content: Project kickoff
 * - date: 2024-02-01
 *   end: 2024-03-01
 *   content: Development phase
 * ```
 */
function parseTimelineItems(
  source: string,
): { id: number; content: string; start: string; end?: string }[] {
  const items: { id: number; content: string; start: string; end?: string }[] = [];
  let current: Partial<{ content: string; start: string; end: string }> = {};
  let id = 0;

  for (const line of source.split("\n")) {
    const trimmed = line.trim();

    // Shorthand: "- 2024-01-15: Description text"
    const shorthand = trimmed.match(/^-\s+(\d{4}-\d{2}-\d{2}):\s*(.+)$/);
    if (shorthand) {
      if (current.start && current.content) {
        items.push({ id: id++, ...current } as (typeof items)[number]);
      }
      current = { start: shorthand[1]!, content: shorthand[2]! };
      continue;
    }

    if (trimmed.startsWith("- date:") || trimmed.startsWith("- start:")) {
      // Save previous item if exists
      if (current.start && current.content) {
        items.push({ id: id++, ...current } as (typeof items)[number]);
      }
      current = { start: trimmed.replace(/^-\s+(date|start):\s*/, "").trim() };
    } else if (trimmed.startsWith("end:")) {
      current.end = trimmed.replace(/^end:\s*/, "").trim();
    } else if (trimmed.startsWith("content:")) {
      current.content = trimmed.replace(/^content:\s*/, "").trim();
    } else if (trimmed.startsWith("title:")) {
      current.content = trimmed.replace(/^title:\s*/, "").trim();
    }
  }
  // Push last item
  if (current.start && current.content) {
    items.push({ id: id++, ...current } as (typeof items)[number]);
  }

  return items;
}

/** Create a Marked extension for ```timeline blocks. */
function markedTimeline(): MarkedExtension {
  return {
    renderer: {
      code(token: Tokens.Code) {
        if (token.lang !== "timeline") return false;
        return `<div class="timeline-block" data-timeline-source="${encodeSource(token.text)}"><div class="timeline-loading">Loading timeline\u2026</div></div>`;
      },
    },
  };
}

/** Post-processor: render vis-timeline widgets. */
function postprocess(container: HTMLElement): (() => void) | void {
  if (!timelineMod || !dataSetMod) return;

  const blocks = container.querySelectorAll<HTMLDivElement>(
    ".timeline-block[data-timeline-source]",
  );
  if (blocks.length === 0) return;

  const { Timeline } = timelineMod;
  const { DataSet } = dataSetMod;
  const timelines: InstanceType<typeof Timeline>[] = [];

  for (const block of blocks) {
    const source = decodeSource(block.getAttribute("data-timeline-source") ?? "");
    if (!source) continue;

    const items = parseTimelineItems(source);
    if (items.length === 0) continue;

    block.textContent = "";
    const div = document.createElement("div");
    div.id = `timeline-${++idCounter}`;
    div.style.height = "300px";
    block.appendChild(div);

    const isDark = document.documentElement.classList.contains("dark");
    try {
      const dataset = new DataSet(items);
      const timeline = new Timeline(div, dataset, {
        height: "300px",
        zoomMin: 1000 * 60 * 60 * 24, // 1 day
        zoomMax: 1000 * 60 * 60 * 24 * 365 * 5, // 5 years
        ...(isDark
          ? {
              template: (item: { content: string }) => {
                const span = document.createElement("span");
                span.style.color = "#e0e0e8";
                span.textContent = item.content;
                return span.outerHTML;
              },
            }
          : {}),
      });
      timelines.push(timeline);
      block.classList.add("timeline-rendered");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      block.textContent = "";
      const errDiv = document.createElement("div");
      errDiv.className = "timeline-error";
      const strong = document.createElement("strong");
      strong.textContent = "Timeline error";
      const pre = document.createElement("pre");
      pre.textContent = msg;
      errDiv.appendChild(strong);
      errDiv.appendChild(pre);
      block.appendChild(errDiv);
    }
  }

  return () => {
    for (const t of timelines) t.destroy();
  };
}

/** Timelines extension — ```timeline fenced blocks rendered via vis-timeline. */
const timelinesExtension: MarkdownExtension = {
  id: "timelines",
  name: "Timelines",
  description: "```timeline interactive visual timelines",
  category: "diagrams",
  defaultEnabled: false,
  toolbarInsert:
    "```timeline\n- date: 2024-01-15\n  content: Project kickoff\n- date: 2024-03-01\n  content: Milestone 1\n- date: 2024-06-01\n  content: Launch\n```",
  toolbarOrder: 88,
  iconPath:
    "M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z",

  markedExtension: () => markedTimeline(),
  postprocess,
  purifyAttrs: ["data-timeline-source"],

  load: async () => {
    if (!timelineMod) {
      timelineMod = await import("vis-timeline/standalone");
      // vis-timeline CSS for layout — non-critical, app works without it
      import("vis-timeline/styles/vis-timeline-graph2d.min.css").catch(() => {});
    }
    if (!dataSetMod) {
      dataSetMod = await import("vis-data");
    }
  },
};

registerExtension(timelinesExtension);

export default timelinesExtension;
