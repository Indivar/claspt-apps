// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * The extension never sets HTML from a string: every page-facing element is
 * built with DOM calls, and no component uses dangerouslySetInnerHTML. React
 * DOM still ships the helper behind that prop, and it is the only code in the
 * built extension that assigns innerHTML from a value. Mozilla's add-on
 * validator flags it on every submission, and a warning from a library is
 * still a warning in a security product's listing.
 *
 * So the build removes the capability instead of explaining it: React DOM's
 * setInnerHTML becomes a function that throws. A component that ever tried
 * dangerouslySetInnerHTML would fail its first render in development, which
 * is the behaviour we want. The match is exact and must occur once; a React
 * upgrade that changes the helper fails the build here, in the open, rather
 * than shipping the assignment again. scripts/check-bundles.mjs then checks
 * the finished bundles independently.
 */

/** React DOM 18's setInnerHTML, as the production build spells it. */
const SET_INNER_HTML =
  /\(function\((\w+),(\w+)\)\{if\("http:\/\/www\.w3\.org\/2000\/svg"!==\1\.namespaceURI\|\|"innerHTML"in \1\)\1\.innerHTML=\2;else\{(\w+)=\3\|\|document\.createElement\("div"\);\3\.innerHTML="<svg>"\+\2\.valueOf\(\)\.toString\(\)\+"<\/svg>";for\(\2=\3\.firstChild;\1\.firstChild;\)\1\.removeChild\(\1\.firstChild\);for\(;\2\.firstChild;\)\1\.appendChild\(\2\.firstChild\)\}\}\)/g;

const REPLACEMENT =
  '(function(){throw Error("Claspt: dangerouslySetInnerHTML is disabled in the extension build")})';

/** The React DOM file the transform applies to, matched on the module id. */
export const REACT_DOM_PRODUCTION =
  /[\\/]react-dom[\\/]cjs[\\/]react-dom\.production\.min\.js$/;

/**
 * @param {string} code React DOM's production source.
 * @returns {string} The same code with the innerHTML helper replaced.
 * @throws when the helper is not found exactly once, so the build fails
 *   instead of shipping the assignment.
 */
export function disableHtmlInjection(code) {
  const matches = code.match(SET_INNER_HTML) ?? [];
  if (matches.length !== 1) {
    throw new Error(
      `no-html-injection: expected React DOM's setInnerHTML exactly once, found ${matches.length}. ` +
        "React DOM changed; update SET_INNER_HTML in scripts/no-html-injection.mjs.",
    );
  }
  return code.replace(SET_INNER_HTML, REPLACEMENT);
}

/** @returns {import("vite").Plugin} */
export function noHtmlInjection() {
  return {
    name: "claspt-no-html-injection",
    // Before Vite's CommonJS conversion, so the raw file is what is matched.
    enforce: "pre",
    transform(code, id) {
      if (!REACT_DOM_PRODUCTION.test(id)) return null;
      return { code: disableHtmlInjection(code), map: null };
    },
  };
}
