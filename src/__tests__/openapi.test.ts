// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * The OpenAPI document and the local API's route table must agree.
 *
 * `docs/api/openapi.yaml` is what the docs site shows and what a tool loads
 * to learn the API; `src-tauri/src/local_api/server.rs` is what actually
 * answers. A route added to one and not the other is a documentation bug
 * nobody would notice for months, so this test reads both and fails when
 * they differ.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load } from "js-yaml";

const ROOT = resolve(__dirname, "..", "..");
const METHODS = ["get", "post", "put", "patch", "delete"] as const;

/** Every `.route("path", get(a).post(b))` in the router, as method + path. */
export function routesInRouter(source: string): Set<string> {
  const found = new Set<string>();
  let at = source.indexOf(".route(");
  while (at !== -1) {
    // Read to the parenthesis that closes this `.route(` call.
    let depth = 0;
    let end = at + ".route".length;
    for (; end < source.length; end++) {
      const ch = source[end];
      if (ch === "(") depth += 1;
      if (ch === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const call = source.slice(at, end + 1);
    const path = /"([^"]+)"/.exec(call)?.[1];
    if (path) {
      for (const method of METHODS) {
        if (new RegExp(`\\b${method}\\(`).test(call))
          found.add(`${method.toUpperCase()} ${path}`);
      }
    }
    at = source.indexOf(".route(", end);
  }
  return found;
}

interface Spec {
  info: { version: string };
  paths: Record<
    string,
    Record<string, { operationId?: string; responses?: Record<string, unknown> }>
  >;
}

function routesInSpec(spec: Spec): Set<string> {
  const found = new Set<string>();
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of METHODS) {
      if (method in item) found.add(`${method.toUpperCase()} ${path}`);
    }
  }
  return found;
}

const spec = load(readFileSync(resolve(ROOT, "docs/api/openapi.yaml"), "utf8")) as Spec;
const router = readFileSync(resolve(ROOT, "src-tauri/src/local_api/server.rs"), "utf8");

describe("the OpenAPI document", () => {
  it("names every route the app serves, and nothing it does not", () => {
    const served = routesInRouter(router);
    const documented = routesInSpec(spec);
    const undocumented = [...served].filter((r) => !documented.has(r)).sort();
    const phantom = [...documented].filter((r) => !served.has(r)).sort();
    expect(
      undocumented,
      "served by the app but missing from docs/api/openapi.yaml",
    ).toEqual([]);
    expect(phantom, "in docs/api/openapi.yaml but not served by the app").toEqual([]);
    expect(served.size).toBeGreaterThan(40);
  });

  it("gives every operation an id and a success response", () => {
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const method of METHODS) {
        const op = item[method];
        if (!op) continue;
        expect(op.operationId, `${method.toUpperCase()} ${path}`).toBeTruthy();
        const ok = Object.keys(op.responses ?? {}).some((code) => code.startsWith("2"));
        expect(ok, `${method.toUpperCase()} ${path} has no 2xx response`).toBe(true);
      }
    }
  });

  it("carries the app's version", () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
      version: string;
    };
    expect(spec.info.version).toBe(pkg.version);
  });

  it("reads the router's own shape", () => {
    const sample = `
      .route("/api/a", get(routes::a).post(routes::b))
      .route(
          "/api/b/{id}",
          patch(routes::c).delete(routes::d),
      )
      .layer(x)`;
    expect([...routesInRouter(sample)].sort()).toEqual([
      "DELETE /api/b/{id}",
      "GET /api/a",
      "PATCH /api/b/{id}",
      "POST /api/a",
    ]);
  });
});
