// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * kanban.ts — kanban boards from ```kanban fenced blocks.
 *
 * Parses a lightweight `## Column` / `- [ ] task` syntax into columns and renders
 * a read-only board of cards. Pure DOM/HTML output, no external library.
 */
import type { MarkedExtension, Tokens } from "marked";
import type { MarkdownExtension } from "./types";
import { registerExtension } from "./registry";
import { encodeSource, decodeSource } from "./preview-pipeline";

/**
 * Parse kanban markdown syntax:
 * ```kanban
 * ## To Do
 * - [ ] Task one
 * - [x] Done task
 * ## In Progress
 * - [ ] Working on this
 * ```
 */
function parseKanban(
  source: string,
): { title: string; tasks: { text: string; done: boolean }[] }[] {
  const columns: { title: string; tasks: { text: string; done: boolean }[] }[] = [];
  let current: { title: string; tasks: { text: string; done: boolean }[] } | null = null;

  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("## ")) {
      current = { title: trimmed.slice(3).trim(), tasks: [] };
      columns.push(current);
    } else if (current && /^-\s+\[[ x]\]\s+/.test(trimmed)) {
      const done = trimmed.includes("[x]");
      const text = trimmed.replace(/^-\s+\[[ x]\]\s+/, "");
      current.tasks.push({ text, done });
    } else if (current && /^-\s+/.test(trimmed)) {
      const text = trimmed.replace(/^-\s+/, "");
      current.tasks.push({ text, done: false });
    }
  }
  return columns;
}

/** Create a Marked extension that captures ```kanban blocks. */
function markedKanban(): MarkedExtension {
  return {
    renderer: {
      code(token: Tokens.Code) {
        if (token.lang !== "kanban") return false;
        return `<div class="kanban-block" data-kanban-source="${encodeSource(token.text)}"></div>`;
      },
    },
  };
}

/** Post-processor: render kanban boards from placeholder divs. */
function postprocess(container: HTMLElement): void {
  const blocks = container.querySelectorAll<HTMLDivElement>(
    ".kanban-block[data-kanban-source]",
  );
  if (blocks.length === 0) return;

  for (const block of blocks) {
    const source = decodeSource(block.getAttribute("data-kanban-source") ?? "");
    if (!source) continue;

    const columns = parseKanban(source);
    if (columns.length === 0) continue;

    block.textContent = "";
    const board = document.createElement("div");
    board.className = "kanban-board";

    for (const col of columns) {
      const colEl = document.createElement("div");
      colEl.className = "kanban-column";

      const header = document.createElement("div");
      header.className = "kanban-column-header";
      header.textContent = col.title;
      const count = document.createElement("span");
      count.className = "kanban-count";
      count.textContent = String(col.tasks.length);
      header.appendChild(count);
      colEl.appendChild(header);

      const list = document.createElement("div");
      list.className = "kanban-cards";
      for (const task of col.tasks) {
        const card = document.createElement("div");
        card.className = `kanban-card${task.done ? " kanban-done" : ""}`;

        const checkbox = document.createElement("span");
        checkbox.className = "kanban-checkbox";
        checkbox.textContent = task.done ? "\u2611" : "\u2610";
        card.appendChild(checkbox);

        const text = document.createElement("span");
        text.textContent = task.text;
        card.appendChild(text);

        list.appendChild(card);
      }
      colEl.appendChild(list);
      board.appendChild(colEl);
    }

    block.appendChild(board);
    block.classList.add("kanban-rendered");
  }
}

/** Kanban extension — ```kanban fenced blocks as visual board. */
const kanbanExtension: MarkdownExtension = {
  id: "kanban",
  name: "Kanban Boards",
  description: "```kanban visual task boards with columns and cards",
  category: "planning",
  defaultEnabled: false,
  toolbarInsert:
    "```kanban\n## To Do\n- [ ] Task one\n- [ ] Task two\n\n## In Progress\n- [ ] Working on this\n\n## Done\n- [x] Completed task\n```",
  toolbarOrder: 95,
  iconPath: "M4 4h4v12H4V4zm6 0h4v8h-4V4zm6 0h4v10h-4V4z",

  markedExtension: () => markedKanban(),
  postprocess,
  purifyAttrs: ["data-kanban-source"],
};

registerExtension(kanbanExtension);

export default kanbanExtension;
