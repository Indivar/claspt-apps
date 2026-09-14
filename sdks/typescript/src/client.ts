// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import { parseReference, referenceToUri } from "./references";

export interface ClasptOptions {
  /** A token from Settings > Integrations or `claspt tokens create`. */
  token: string;
  /** The desktop's local API port (default 9315). */
  port?: number;
  /** Full base URL; the host is always loopback. */
  baseUrl?: string;
  /** Provide `fetch` when the runtime has none or a test wants to intercept. */
  fetch?: typeof fetch;
}

export class ClasptError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(status ? `${status}: ${message}` : message);
    this.name = "ClasptError";
  }
}

export type Json = Record<string, unknown>;

export interface MemoryWriteOptions {
  namespace: string;
  tags?: string[];
  kind?: "episodic" | "semantic" | "procedural";
  ifMatch?: string;
  valid_from?: string;
  valid_until?: string;
  superseded_by?: string;
  verified_on?: string;
}

export class ClasptClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ClasptOptions) {
    if (!options.token) throw new ClasptError(0, "no token: pass token");
    this.token = options.token;
    this.baseUrl = options.baseUrl ?? `http://127.0.0.1:${options.port ?? 9315}`;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (!this.fetchImpl) throw new ClasptError(0, "no fetch available; pass one in options");
  }

  async request<T = Json>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.baseUrl + path, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new ClasptError(0, `cannot reach Claspt at ${this.baseUrl}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const text = await response.text();
    if (!response.ok) {
      let message = text;
      try {
        const parsed = JSON.parse(text) as { message?: string };
        if (parsed && typeof parsed.message === "string") message = parsed.message;
      } catch {
        // plain text body
      }
      throw new ClasptError(response.status, message || response.statusText);
    }
    if (!text) return undefined as T;
    const parsed = JSON.parse(text) as T;
    const etag = response.headers.get("etag");
    if (etag && parsed && typeof parsed === "object" && !("etag" in (parsed as object))) {
      (parsed as Json).etag = etag;
    }
    return parsed;
  }

  status(): Promise<Json> {
    return this.request("GET", "/api/status");
  }

  // ── memory ──

  async memoryGuide(): Promise<string> {
    const r = await this.request<{ guide: string }>("GET", "/api/memory/guide");
    return r.guide;
  }

  memoryList(namespace: string, tag?: string): Promise<Json[]> {
    const path = `/api/memory/${encodeURIComponent(namespace)}` + (tag ? `?tag=${encodeURIComponent(tag)}` : "");
    return this.request<Json[]>("GET", path);
  }

  memoryRead(title: string, namespace: string, options: { maxBytes?: number; tail?: boolean } = {}): Promise<Json> {
    const params = new URLSearchParams();
    if (options.maxBytes !== undefined) params.set("max_bytes", String(options.maxBytes));
    if (options.tail) params.set("tail", "true");
    const query = params.toString();
    return this.request("GET", `/api/memory/${encodeURIComponent(namespace)}/${encodeURIComponent(title)}${query ? "?" + query : ""}`);
  }

  memoryUpsert(title: string, content: string, options: MemoryWriteOptions): Promise<Json> {
    const { namespace, ifMatch, tags, ...rest } = options;
    const body: Json = { title, content, tags: tags ?? [] };
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) body[k] = v;
    return this.request("PUT", `/api/memory/${encodeURIComponent(namespace)}`, body, ifMatch ? { "If-Match": ifMatch } : {});
  }

  memoryAppend(title: string, text: string, namespace: string, ifMatch?: string): Promise<Json> {
    return this.request(
      "POST",
      `/api/memory/${encodeURIComponent(namespace)}/${encodeURIComponent(title)}/append`,
      { text },
      ifMatch ? { "If-Match": ifMatch } : {},
    );
  }

  memorySearch(query: string, options: { namespaces?: string[]; limit?: number } = {}): Promise<Json> {
    const params = new URLSearchParams({ q: query, limit: String(options.limit ?? 10) });
    if (options.namespaces?.length) params.set("namespaces", options.namespaces.join(","));
    return this.request("GET", `/api/memory/search?${params.toString()}`);
  }

  memoryVerify(title: string, namespace: string): Promise<Json> {
    return this.request("POST", `/api/memory/${encodeURIComponent(namespace)}/${encodeURIComponent(title)}/verify`, {});
  }

  memoryCompact(title: string, namespace: string, keepSections = 10): Promise<Json> {
    return this.request("POST", `/api/memory/${encodeURIComponent(namespace)}/${encodeURIComponent(title)}/compact`, {
      keep_sections: keepSections,
    });
  }

  // ── secrets ──

  findSecrets(query?: string): Promise<Array<Json & { reference_prefix: string }>> {
    return this.request("GET", "/api/secrets" + (query ? `?q=${encodeURIComponent(query)}` : ""));
  }

  storeSecret(service: string, label: string, fields: Record<string, string>, tags: string[] = []): Promise<Json> {
    return this.request("POST", "/api/secrets", { service, label, fields, tags, agent_ns: "sdk" });
  }

  /** A page's secret blocks. The owner may be asked to approve. */
  readSecret(page: string): Promise<{ items: Array<{ label: string; fields: Record<string, string>; references?: Record<string, string> }> }> {
    return this.request("GET", `/api/pages/${encodeURIComponent(page)}/secret`);
  }

  /** One field by reference. */
  async readSecretByReference(reference: string): Promise<{ reference: string; value: string }> {
    const ref = parseReference(reference);
    const listing = await this.readSecret(ref.page);
    let blocks = listing.items ?? [];
    if (ref.block !== undefined) {
      blocks = blocks.filter((b) => b.label === ref.block);
      if (blocks.length === 0) throw new ClasptError(404, `page ${ref.page} has no secret block '${ref.block}'`);
    }
    const block = blocks[0];
    if (blocks.length !== 1 || !block) {
      throw new ClasptError(409, `page ${ref.page} has ${blocks.length} secret blocks; add ?block=<label> (${blocks.map((b) => b.label).join(", ")})`);
    }
    const fields = block.fields as Record<string, unknown>;
    if (fields.redacted === true) throw new ClasptError(403, "this token has Notes scope; a reference needs a Secrets-scope token");
    const value = fields[ref.field];
    if (typeof value !== "string") throw new ClasptError(404, `secret block has no field '${ref.field}' (fields: ${Object.keys(fields).join(", ")})`);
    return { reference: referenceToUri(ref), value };
  }

  // ── audits ──

  auditSecrets(): Promise<Json[]> {
    return this.request("GET", "/api/audit/secrets");
  }

  rotationDue(): Promise<Json> {
    return this.request("GET", "/api/audit/rotation");
  }
}
