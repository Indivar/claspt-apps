// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * The `info.version` line of the OpenAPI document, read and written without
 * caring whether the file arrived with LF or CRLF line endings. A Windows
 * checkout has CRLF, and a pattern that assumed LF stopped the Windows
 * release build of 4.2.0 before it compiled anything.
 */

const VERSION_LINE =
  /^(info:\r?\n(?:[ \t]+[^\r\n]*\r?\n)*?[ \t]+version:[ \t]*)([^\r\n]*)$/m;

/** The version the document states, or null when the line is missing. */
export function readOpenapiVersion(text) {
  const match = text.match(VERSION_LINE);
  return match ? match[2] : null;
}

/** The same text with the version replaced; null when the line is missing. */
export function writeOpenapiVersion(text, version) {
  if (!VERSION_LINE.test(text)) return null;
  return text.replace(VERSION_LINE, `$1${version}`);
}
