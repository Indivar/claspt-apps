// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/** `claspt://secret/<page>?block=<label>#<field>` references. */

export const PREFIX = "claspt://secret/";

export interface SecretReference {
  page: string;
  field: string;
  block?: string;
}

export function referenceToUri(ref: SecretReference): string {
  let uri = PREFIX + ref.page.split("/").map(encodeURIComponent).join("/");
  if (ref.block !== undefined) uri += "?block=" + encodeURIComponent(ref.block);
  return uri + "#" + encodeURIComponent(ref.field);
}

export function parseReference(text: string): SecretReference {
  if (!text.startsWith(PREFIX)) throw new Error(`not a secret reference (expected ${PREFIX}...): ${text}`);
  const rest = text.slice(PREFIX.length);
  const hash = rest.lastIndexOf("#");
  if (hash < 0) throw new Error(`reference has no #field: ${text}`);
  const before = rest.slice(0, hash);
  const field = decodeURIComponent(rest.slice(hash + 1));
  const q = before.indexOf("?");
  const page = decodeURIComponent(q < 0 ? before : before.slice(0, q));
  const query = q < 0 ? "" : before.slice(q + 1);
  if (!page || !field) throw new Error(`reference needs a page and a field: ${text}`);
  let block: string | undefined;
  for (const pair of query.split("&").filter(Boolean)) {
    const [key, value = ""] = pair.split("=", 2);
    if (key === "block") block = decodeURIComponent(value);
    else throw new Error(`unknown reference option '${pair}' in ${text}`);
  }
  return block === undefined ? { page, field } : { page, field, block };
}
