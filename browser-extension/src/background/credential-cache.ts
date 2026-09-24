// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import type { Credential, SearchResult } from "@/shared/types";
import { extractSecretBlocks } from "@claspt/shared/secret-parser";
import { scoreCredentialMatch } from "@/shared/url-matching";
import type { ApiClient } from "./api-client";

/**
 * Credential cache that resolves domain -> Credential[] lookups.
 *
 * Strategy:
 * 1. Search the API for the domain/hostname
 * 2. Fetch matching pages to get decrypted secret blocks
 * 3. Parse secret blocks into structured credentials
 * 4. Score and sort by relevance to the requesting URL
 */
export class CredentialCache {
  /** In-memory cache: domain -> credentials (cleared on vault lock) */
  private cache = new Map<string, { credentials: Credential[]; timestamp: number }>();
  private readonly TTL_MS = 60_000; // 1 minute cache

  constructor(private api: ApiClient) {}

  updateApi(api: ApiClient) {
    this.api = api;
  }

  /** Clear all cached credentials (e.g., when vault locks) */
  clear() {
    this.cache.clear();
  }

  /**
   * Find credentials matching a tab URL.
   * Uses Tier 1 (url field match) and Tier 2 (search API) strategies.
   */
  async getCredentialsForUrl(tabUrl: string): Promise<Credential[]> {
    const hostname = new URL(tabUrl).hostname;
    const cached = this.cache.get(hostname);
    if (cached && Date.now() - cached.timestamp < this.TTL_MS) {
      return cached.credentials;
    }

    const credentials = await this.fetchCredentials(tabUrl, hostname);
    this.cache.set(hostname, { credentials, timestamp: Date.now() });
    return credentials;
  }

  /** Search credentials by arbitrary query */
  async searchCredentials(query: string): Promise<Credential[]> {
    const results = await this.api.search(query, "secrets");
    return this.resolveSearchResults(results);
  }

  private async fetchCredentials(tabUrl: string, hostname: string): Promise<Credential[]> {
    // Search with multiple queries to maximize matches.
    // For "insurance.ami.co.nz" we search:
    //   1. "insurance.ami.co.nz" (full hostname)
    //   2. "ami.co.nz" (parent domain)
    //   3. "ami" (base name)
    const cleanHost = hostname.replace(/^www\./, "");
    const parts = cleanHost.split(".");

    // Build search queries: full host, then progressively shorter
    const queries = new Set<string>();
    queries.add(cleanHost); // insurance.ami.co.nz
    if (parts.length > 2) {
      // ami.co.nz (remove subdomain)
      queries.add(parts.slice(1).join("."));
    }
    // Base domain name: ami
    const base = parts.length > 2 ? parts[1] : parts[0];
    if (base) queries.add(base);

    const seen = new Set<string>();
    const allResults: import("@/shared/types").SearchResult[] = [];

    for (const query of queries) {
      try {
        const results = await this.api.search(query, "secrets");
        for (const r of results) {
          if (!seen.has(r.path)) { seen.add(r.path); allResults.push(r); }
        }
      } catch { /* ignore */ }
    }

    const credentials = await this.resolveSearchResults(allResults);

    // Score, sort by relevance, and attach scores for filter tiers.
    // Honors per-credential url_match policy when set in the secret block:
    //   url_match: never|exact|host|base_domain
    const policyOf = (cred: Credential): "base_domain" | "host" | "exact" | "never" | undefined => {
      const raw = (cred.fields["url_match"] || cred.fields["url match"] || "").toLowerCase().trim();
      if (raw === "never" || raw === "exact" || raw === "host" || raw === "base_domain") return raw;
      return undefined;
    };
    return credentials
      .map((cred) => ({
        ...cred,
        score: scoreCredentialMatch(tabUrl, {
          url: cred.url,
          label: cred.label,
          pageTitle: cred.pageTitle,
        }, policyOf(cred)),
      }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }

  private async resolveSearchResults(results: SearchResult[]): Promise<Credential[]> {
    const credentials: Credential[] = [];
    const seen = new Set<string>();

    for (const result of results) {
      if (seen.has(result.path)) continue;
      seen.add(result.path);

      try {
        const page = await this.api.getPage(result.path);
        const blocks = extractSecretBlocks(page.content);

        for (const block of blocks) {
          const tags = page.meta?.tags ?? [];
          credentials.push({
            pagePath: result.path,
            pageTitle: page.meta?.title ?? result.title,
            label: block.label,
            fields: block.fields,
            url: block.fields["url"] || block.fields["site"] || block.fields["website"],
            tags,
            captured: tags.includes("captured"),
          });
        }
      } catch {
        // Page may have been deleted or locked — skip
      }
    }

    return credentials;
  }
}
