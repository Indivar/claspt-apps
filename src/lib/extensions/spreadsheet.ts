// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * spreadsheet.ts — CSV/spreadsheet tables from ```spreadsheet / ```csv blocks.
 *
 * Renders comma-separated rows as a table and evaluates simple `=`-prefixed
 * arithmetic formulas. Formula evaluation uses a hand-rolled recursive-descent
 * parser ({@link safeEvalArithmetic}) — never `eval`/`Function` — so it stays
 * safe under the app's strict CSP.
 */
import type { MarkedExtension, Tokens } from "marked";
import type { MarkdownExtension } from "./types";
import { registerExtension } from "./registry";
import { encodeSource, decodeSource } from "./preview-pipeline";

/** Parse CSV-like source into a 2D string array. */
function parseCsv(source: string): string[][] {
  return source
    .trim()
    .split("\n")
    .map((line) => line.split(",").map((cell) => cell.trim()));
}

/**
 * Evaluate a simple arithmetic expression using a recursive descent parser.
 * Supports: +, -, *, /, parentheses, decimal numbers.
 * No eval/Function — safe under strict CSP.
 */
function safeEvalArithmetic(expr: string): number {
  const tokens = expr.match(/(\d+\.?\d*|[+\-*/()])/g) ?? [];
  if (tokens.length === 0) return NaN;
  let pos = 0;

  function peek(): string | undefined {
    return tokens[pos];
  }
  function consume(): string {
    return tokens[pos++]!;
  }

  function parseExpr(): number {
    let left = parseTerm();
    while (peek() === "+" || peek() === "-") {
      const op = consume();
      const right = parseTerm();
      left = op === "+" ? left + right : left - right;
    }
    return left;
  }

  function parseTerm(): number {
    let left = parseFactor();
    while (peek() === "*" || peek() === "/") {
      const op = consume();
      const right = parseFactor();
      left = op === "*" ? left * right : left / right;
    }
    return left;
  }

  function parseFactor(): number {
    if (peek() === "(") {
      consume();
      const val = parseExpr();
      if (peek() === ")") consume();
      return val;
    }
    if (peek() === "-") {
      consume();
      return -parseFactor();
    }
    const tok = consume();
    if (tok === undefined) return NaN;
    return parseFloat(tok);
  }

  const result = parseExpr();
  return pos === tokens.length ? result : NaN;
}

/**
 * Evaluate simple spreadsheet formulas.
 * Supports: =SUM(A1:A3), =AVG(A1:A3), =COUNT(A1:A3), arithmetic (=A1+B1*2)
 */
function evaluateFormula(formula: string, grid: string[][]): string {
  const f = formula.slice(1).trim();

  // Cell reference pattern: letter + number (e.g., A1, B3)
  const cellRef = /^([A-Z])(\d+)$/i;
  const rangeRef = /^([A-Z])(\d+):([A-Z])(\d+)$/i;

  function getCellValue(ref: string): number {
    const m = ref.match(cellRef);
    if (!m) return 0;
    const col = m[1]!.toUpperCase().charCodeAt(0) - 65;
    const row = parseInt(m[2]!, 10) - 1;
    const val = grid[row]?.[col] ?? "";
    if (val.startsWith("=")) return NaN; // Don't recurse
    return parseFloat(val) || 0;
  }

  function getRange(ref: string): number[] {
    const m = ref.match(rangeRef);
    if (!m) return [];
    const col1 = m[1]!.toUpperCase().charCodeAt(0) - 65;
    const row1 = parseInt(m[2]!, 10) - 1;
    const col2 = m[3]!.toUpperCase().charCodeAt(0) - 65;
    const row2 = parseInt(m[4]!, 10) - 1;
    const values: number[] = [];
    for (let r = Math.min(row1, row2); r <= Math.max(row1, row2); r++) {
      for (let c = Math.min(col1, col2); c <= Math.max(col1, col2); c++) {
        const val = grid[r]?.[c] ?? "";
        if (!val.startsWith("=")) {
          values.push(parseFloat(val) || 0);
        }
      }
    }
    return values;
  }

  // SUM, AVG, COUNT functions
  const funcMatch = f.match(/^(SUM|AVG|AVERAGE|COUNT)\((.+)\)$/i);
  if (funcMatch) {
    const func = funcMatch[1]!.toUpperCase();
    const range = getRange(funcMatch[2]!);
    if (range.length === 0) return "0";
    switch (func) {
      case "SUM":
        return String(range.reduce((a, b) => a + b, 0));
      case "AVG":
      case "AVERAGE":
        return String(range.reduce((a, b) => a + b, 0) / range.length);
      case "COUNT":
        return String(range.length);
    }
  }

  // Simple arithmetic with cell references — replace refs with numeric values
  const expr = f.replace(/[A-Z]\d+/gi, (ref) => String(getCellValue(ref)));
  const result = safeEvalArithmetic(expr);
  return isNaN(result) ? "#ERR" : String(result);
}

/** Process formulas in a grid, returning display values. */
function processGrid(grid: string[][]): string[][] {
  return grid.map((row) =>
    row.map((cell) => {
      if (cell.startsWith("=")) {
        return evaluateFormula(cell, grid);
      }
      return cell;
    }),
  );
}

/** Create a Marked extension for ```spreadsheet blocks. */
function markedSpreadsheet(): MarkedExtension {
  return {
    renderer: {
      code(token: Tokens.Code) {
        if (token.lang !== "spreadsheet" && token.lang !== "csv") return false;
        return `<div class="spreadsheet-block" data-spreadsheet-source="${encodeSource(token.text)}"></div>`;
      },
    },
  };
}

/** Post-processor: render spreadsheet tables. */
function postprocess(container: HTMLElement): void {
  const blocks = container.querySelectorAll<HTMLDivElement>(
    ".spreadsheet-block[data-spreadsheet-source]",
  );
  if (blocks.length === 0) return;

  for (const block of blocks) {
    const source = decodeSource(block.getAttribute("data-spreadsheet-source") ?? "");
    if (!source) continue;

    const rawGrid = parseCsv(source);
    if (rawGrid.length === 0) continue;

    const displayGrid = processGrid(rawGrid);

    block.textContent = "";
    const table = document.createElement("table");
    table.className = "spreadsheet-table";

    // Column headers (A, B, C, ...)
    const maxCols = Math.max(...rawGrid.map((r) => r.length));
    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    const cornerTh = document.createElement("th");
    cornerTh.className = "spreadsheet-corner";
    headerRow.appendChild(cornerTh);
    for (let c = 0; c < maxCols; c++) {
      const th = document.createElement("th");
      th.textContent = String.fromCharCode(65 + c);
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Data rows
    const tbody = document.createElement("tbody");
    for (let r = 0; r < displayGrid.length; r++) {
      const tr = document.createElement("tr");
      const rowHeader = document.createElement("th");
      rowHeader.textContent = String(r + 1);
      tr.appendChild(rowHeader);
      for (let c = 0; c < maxCols; c++) {
        const td = document.createElement("td");
        const val = displayGrid[r]?.[c] ?? "";
        td.textContent = val;
        // Right-align numbers
        if (val && !isNaN(Number(val))) {
          td.style.textAlign = "right";
        }
        if (val === "#ERR") {
          td.style.color = "#ff1744";
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    block.appendChild(table);
    block.classList.add("spreadsheet-rendered");
  }
}

/** Spreadsheet extension — ```spreadsheet / ```csv blocks as tabular grids. */
const spreadsheetExtension: MarkdownExtension = {
  id: "spreadsheets",
  name: "Spreadsheets",
  description: "```spreadsheet CSV grids with SUM, AVG, COUNT formulas",
  category: "planning",
  defaultEnabled: false,
  toolbarInsert:
    "```spreadsheet\nItem, Q1, Q2, Q3\nAlpha, 10, 20, 30\nBeta, 15, 25, 35\nTotal, =SUM(A2:A3), =SUM(B2:B3), =SUM(C2:C3)\n```",
  toolbarOrder: 100,
  iconPath: "M4 4h16v16H4V4zm2 4v3h5V8H6zm7 0v3h5V8h-5zm-7 5v3h5v-3H6zm7 0v3h5v-3h-5z",

  markedExtension: () => markedSpreadsheet(),
  postprocess,
  purifyAttrs: ["data-spreadsheet-source"],
};

registerExtension(spreadsheetExtension);

export default spreadsheetExtension;
