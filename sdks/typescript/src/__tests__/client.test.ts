// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { describe, it, expect } from "vitest";
import { ClasptClient, ClasptError, parseReference, referenceToUri, tools } from "../index";

interface Call {
  method: string;
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

function fakeFetch(table: Record<string, { status: number; body: unknown; headers?: Record<string, string> }>) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers });
    const key = `${init?.method ?? "GET"} ${new URL(url).pathname}`;
    const entry = table[key] ?? { status: 404, body: { message: "no route" } };
    return new Response(JSON.stringify(entry.body), { status: entry.status, headers: { "content-type": "application/json", ...(entry.headers ?? {}) } });
  }) as typeof fetch;
  return { impl, calls };
}

describe("ClasptClient", () => {
  it("sends the bearer token, If-Match and query parameters, and keeps the etag", async () => {
    const { impl, calls } = fakeFetch({
      "PUT /api/memory/proj": { status: 200, body: { meta: { title: "decisions" } }, headers: { etag: "2026-01-01T00:00:00Z" } },
      "GET /api/memory/proj/session-log": { status: 200, body: { content: "x" } },
      "GET /api/memory/search": { status: 200, body: { hits: [] } },
    });
    const client = new ClasptClient({ token: "clss_t", port: 9999, fetch: impl });
    const page = await client.memoryUpsert("decisions", "# D", { namespace: "proj", kind: "semantic", ifMatch: "e1", tags: ["a"] });
    expect(page.etag).toBe("2026-01-01T00:00:00Z");
    await client.memoryRead("session-log", "proj", { maxBytes: 100, tail: true });
    await client.memorySearch("db", { namespaces: ["proj", "global"], limit: 3 });
    expect(calls[0]?.headers.Authorization).toBe("Bearer clss_t");
    expect(calls[0]?.headers["If-Match"]).toBe("e1");
    expect(calls[0]?.body).toEqual({ title: "decisions", content: "# D", tags: ["a"], kind: "semantic" });
    expect(calls[1]?.url).toBe("http://127.0.0.1:9999/api/memory/proj/session-log?max_bytes=100&tail=true");
    expect(calls[2]?.url).toContain("namespaces=proj%2Cglobal");
  });

  it("reads one field by reference and refuses ambiguity, redaction and missing fields", async () => {
    const { impl } = fakeFetch({
      "GET /api/pages/ai%2Fstripe.md/secret": {
        status: 200,
        body: { items: [{ label: "Live", fields: { api_key: "sk" } }, { label: "Test", fields: { api_key: "tk" } }] },
      },
      "GET /api/pages/ai%2Fx.md/secret": { status: 200, body: { items: [{ label: "A", fields: { redacted: true } }] } },
    });
    const client = new ClasptClient({ token: "t", fetch: impl });
    await expect(client.readSecretByReference("claspt://secret/ai/stripe.md?block=Test#api_key")).resolves.toEqual({
      reference: "claspt://secret/ai/stripe.md?block=Test#api_key",
      value: "tk",
    });
    await expect(client.readSecretByReference("claspt://secret/ai/stripe.md#api_key")).rejects.toMatchObject({ status: 409 });
    await expect(client.readSecretByReference("claspt://secret/ai/stripe.md?block=Live#nope")).rejects.toMatchObject({ status: 404 });
    await expect(client.readSecretByReference("claspt://secret/ai/x.md#k")).rejects.toMatchObject({ status: 403 });
  });

  it("turns refusals and unreachable hosts into ClasptError", async () => {
    const { impl } = fakeFetch({ "GET /api/audit/rotation": { status: 403, body: { message: "Secrets token required" } } });
    const client = new ClasptClient({ token: "t", fetch: impl });
    await expect(client.rotationDue()).rejects.toMatchObject({ status: 403, message: "403: Secrets token required" });
    const down = new ClasptClient({ token: "t", fetch: (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch });
    const err = await down.status().catch((e) => e as ClasptError);
    expect(err).toBeInstanceOf(ClasptError);
    expect(err.status).toBe(0);
    expect(() => new ClasptClient({ token: "" })).toThrow(ClasptError);
  });
});

describe("references", () => {
  it("round-trip and refuse malformed forms", () => {
    const ref = { page: "credentials/my page.md", field: "API Key", block: "Prod & Co" };
    expect(parseReference(referenceToUri(ref))).toEqual(ref);
    expect(parseReference("claspt://secret/ai/a.md#token")).toEqual({ page: "ai/a.md", field: "token" });
    for (const bad of ["https://x", "claspt://secret/a.md", "claspt://secret/#f", "claspt://secret/a.md?label=x#f"]) {
      expect(() => parseReference(bad)).toThrow();
    }
  });
});

describe("tools", () => {
  it("define six tools bound to the namespace and call the client", async () => {
    const { impl, calls } = fakeFetch({ "GET /api/memory/search": { status: 200, body: { hits: [] } } });
    const client = new ClasptClient({ token: "t", fetch: impl });
    const defs = tools(client, "proj");
    expect(defs.map((d) => d.name)).toEqual(["memory_read", "memory_upsert", "memory_search", "find_secrets", "read_secret", "store_secret"]);
    for (const d of defs) expect(d.parameters.required.every((r) => r in d.parameters.properties)).toBe(true);
    await defs[2]!.handler({ query: "db" });
    expect(calls[0]?.url).toContain("namespaces=proj%2Cglobal");
    await expect(defs[0]!.handler({})).rejects.toThrow("title must be a string");
  });
});
