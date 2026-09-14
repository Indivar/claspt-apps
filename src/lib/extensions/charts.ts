// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * charts.ts — data charts from ```chart fenced blocks (Chart.js).
 *
 * The block body is YAML describing the chart; the Marked renderer emits a
 * placeholder div and the post-processor parses the YAML (js-yaml) and draws to a
 * `<canvas>`. Rendering to canvas means no HTML-injection surface. Chart.js and
 * js-yaml are lazy-loaded on first use.
 */
import type { MarkedExtension, Tokens } from "marked";
import type { MarkdownExtension } from "./types";
import { registerExtension } from "./registry";
import { encodeSource, decodeSource } from "./preview-pipeline";

/** Cached Chart.js module reference (lazy-loaded). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ChartClass: any = null;
let yamlMod: typeof import("js-yaml") | null = null;

/** Counter for unique chart canvas IDs. */
let idCounter = 0;

/** Create a Marked extension that captures ```chart blocks as placeholder divs. */
function markedChart(): MarkedExtension {
  return {
    renderer: {
      code(token: Tokens.Code) {
        if (token.lang !== "chart") return false;
        return `<div class="chart-block" data-chart-source="${encodeSource(token.text)}"><div class="chart-loading">Loading chart\u2026</div></div>`;
      },
    },
  };
}

/**
 * Post-processor: parse YAML config and render Chart.js canvases.
 *
 * Safety: Chart.js renders to a canvas element — no HTML injection risk.
 * YAML parsing uses js-yaml safeLoad. The parent HTML has already been
 * sanitized through DOMPurify in renderMarkdown().
 */
function postprocess(container: HTMLElement): (() => void) | void {
  if (!ChartClass || !yamlMod) return;

  const blocks = container.querySelectorAll<HTMLDivElement>(
    ".chart-block[data-chart-source]",
  );
  if (blocks.length === 0) return;

  const isDark = document.documentElement.classList.contains("dark");
  const charts: { destroy: () => void }[] = [];

  for (const block of blocks) {
    const source = decodeSource(block.getAttribute("data-chart-source") ?? "");
    if (!source) continue;

    try {
      const config = yamlMod.load(source) as Record<string, unknown>;
      if (!config || typeof config !== "object") {
        throw new Error("Chart config must be a YAML object");
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cfg = config as any;

      // Inject visible default colors if dataset has no backgroundColor
      if (cfg.data?.datasets) {
        const palette = isDark
          ? [
              "#60a5fa",
              "#34d399",
              "#fbbf24",
              "#f87171",
              "#a78bfa",
              "#fb923c",
              "#2dd4bf",
              "#f472b6",
            ]
          : [
              "#3b82f6",
              "#10b981",
              "#f59e0b",
              "#ef4444",
              "#8b5cf6",
              "#f97316",
              "#14b8a6",
              "#ec4899",
            ];
        for (let i = 0; i < cfg.data.datasets.length; i++) {
          const ds = cfg.data.datasets[i];
          if (!ds.backgroundColor) {
            ds.backgroundColor = palette[i % palette.length];
          }
          if (!ds.borderColor && cfg.type !== "bar") {
            ds.borderColor = palette[i % palette.length];
          }
        }
      }

      // Merge dark theme colors into options
      if (isDark) {
        cfg.options = cfg.options || {};
        cfg.options.color = cfg.options.color || "#c0c0d0";
        cfg.options.scales = cfg.options.scales || {};
        for (const axis of ["x", "y"]) {
          cfg.options.scales[axis] = cfg.options.scales[axis] || {};
          cfg.options.scales[axis].ticks = cfg.options.scales[axis].ticks || {};
          cfg.options.scales[axis].ticks.color =
            cfg.options.scales[axis].ticks.color || "#c0c0d0";
          cfg.options.scales[axis].grid = cfg.options.scales[axis].grid || {};
          cfg.options.scales[axis].grid.color =
            cfg.options.scales[axis].grid.color || "rgba(255,255,255,0.08)";
        }
        if (cfg.options.plugins?.legend) {
          cfg.options.plugins.legend.labels = cfg.options.plugins.legend.labels || {};
          cfg.options.plugins.legend.labels.color =
            cfg.options.plugins.legend.labels.color || "#c0c0d0";
        }
      }

      block.textContent = "";

      // Wrapper div with explicit height ensures Chart.js responsive mode works
      const wrapper = document.createElement("div");
      wrapper.style.position = "relative";
      wrapper.style.height = "300px";
      wrapper.style.width = "100%";
      block.appendChild(wrapper);

      const canvas = document.createElement("canvas");
      canvas.id = `chart-${++idCounter}`;
      wrapper.appendChild(canvas);

      const chart = new ChartClass(canvas, cfg);
      charts.push(chart);
      block.classList.add("chart-rendered");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      block.textContent = "";
      const errDiv = document.createElement("div");
      errDiv.className = "chart-error";
      const strong = document.createElement("strong");
      strong.textContent = "Chart error";
      const pre = document.createElement("pre");
      pre.textContent = msg;
      errDiv.appendChild(strong);
      errDiv.appendChild(pre);
      block.appendChild(errDiv);
      block.classList.add("chart-error-state");
    }
  }

  return () => {
    for (const chart of charts) chart.destroy();
  };
}

/** Charts extension — ```chart fenced blocks with YAML Chart.js config. */
const chartsExtension: MarkdownExtension = {
  id: "charts",
  name: "Charts",
  description: "```chart YAML blocks rendered via Chart.js",
  category: "diagrams",
  defaultEnabled: false,
  toolbarInsert:
    "```chart\ntype: bar\ndata:\n  labels: [A, B, C]\n  datasets:\n    - label: Values\n      data: [10, 20, 30]\n```",
  toolbarOrder: 80,
  iconPath: "M5 9.2h3V19H5V9.2zM10.6 5h2.8v14h-2.8V5zm5.6 8H19v6h-2.8v-6z",

  markedExtension: () => markedChart(),
  postprocess,
  purifyAttrs: ["data-chart-source"],

  load: async () => {
    if (!ChartClass) {
      // chart.js/auto auto-registers all controllers, elements, scales, plugins
      const mod = await import("chart.js/auto");
      ChartClass = mod.default || mod.Chart;
    }
    if (!yamlMod) {
      yamlMod = await import("js-yaml");
    }
  },
};

registerExtension(chartsExtension);

export default chartsExtension;
