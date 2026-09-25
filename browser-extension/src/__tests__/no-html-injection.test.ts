// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import {
  REACT_DOM_PRODUCTION,
  disableHtmlInjection,
} from "../../scripts/no-html-injection.mjs";
import { findHtmlInjection } from "../../scripts/check-bundles.mjs";

const require = createRequire(import.meta.url);
// The package's exports map hides the file, so go through its package.json.
const reactDomFile = resolve(
  require.resolve("react-dom/package.json"),
  "..",
  "cjs/react-dom.production.min.js",
);
const reactDom = readFileSync(reactDomFile, "utf8");

describe("disableHtmlInjection", () => {
  it("removes every innerHTML assignment from a value in the installed React DOM", () => {
    // Two in the shipped file: the plain assignment and the SVG fallback.
    expect(findHtmlInjection(reactDom).length).toBe(2);
    const out = disableHtmlInjection(reactDom);
    expect(findHtmlInjection(out)).toEqual([]);
    expect(out).toContain("dangerouslySetInnerHTML is disabled in the extension build");
  });

  it("leaves the rest of the file as it was", () => {
    const out = disableHtmlInjection(reactDom);
    // One function swapped; everything else byte for byte.
    expect(out.length).toBeLessThan(reactDom.length);
    expect(out.slice(0, 2000)).toBe(reactDom.slice(0, 2000));
    expect(out.slice(-2000)).toBe(reactDom.slice(-2000));
  });

  it("the replacement throws when React would set HTML", () => {
    const out = disableHtmlInjection(reactDom);
    const start = out.indexOf("(function(){throw Error(");
    const end = out.indexOf("})", start) + 2;
    const replacement = new Function(`return ${out.slice(start, end)}`)() as () => void;
    expect(() => replacement()).toThrow(/disabled in the extension build/);
  });

  it("fails closed when React DOM no longer matches", () => {
    expect(() => disableHtmlInjection("var x = 1;")).toThrow(
      /expected React DOM's setInnerHTML/,
    );
    expect(() => disableHtmlInjection(reactDom + reactDom)).toThrow(/found 2/);
  });

  it("targets the production React DOM file and nothing else", () => {
    expect(REACT_DOM_PRODUCTION.test(reactDomFile)).toBe(true);
    expect(
      REACT_DOM_PRODUCTION.test(
        resolve("node_modules/react-dom/cjs/react-dom.development.js"),
      ),
    ).toBe(false);
    expect(REACT_DOM_PRODUCTION.test(resolve("src/popup/App.tsx"))).toBe(false);
  });
});

describe("findHtmlInjection", () => {
  it("flags HTML set from a value and the other injection sinks", () => {
    expect(findHtmlInjection("el.innerHTML = value;")).toEqual([
      { name: "innerHTML or outerHTML assigned from a value", line: 1 },
    ]);
    expect(findHtmlInjection("a\nb.outerHTML=c")[0].line).toBe(2);
    expect(findHtmlInjection("el.insertAdjacentHTML('beforeend', s)").length).toBe(1);
    expect(findHtmlInjection("document.write(s)").length).toBe(1);
  });

  it("allows a string literal, a comparison, and a read", () => {
    expect(findHtmlInjection('div.innerHTML = "<svg></svg>";')).toEqual([]);
    expect(findHtmlInjection("if (el.innerHTML === x) {}")).toEqual([]);
    expect(findHtmlInjection("const s = el.innerHTML;")).toEqual([]);
    expect(findHtmlInjection('"innerHTML" in el')).toEqual([]);
  });
});
