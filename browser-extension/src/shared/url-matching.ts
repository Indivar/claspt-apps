// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Domain extraction and matching for credential lookup.
 *
 * Adapted from Browserpass (ISC license) domain matching strategy.
 * Matches credentials to websites using eTLD+1 comparison.
 */

import { PUBLIC_SUFFIX_RULES } from "./public-suffix-data";

/**
 * Extract the registrable domain (eTLD+1) from a URL string.
 * Falls back to hostname if URL parsing fails.
 *
 * Examples:
 *   "https://login.github.com/auth" -> "github.com"
 *   "https://app.example.co.uk"     -> "example.co.uk"
 *   "192.168.1.1:8080"              -> "192.168.1.1"
 */
export function extractDomain(urlStr: string): string | null {
  try {
    // Ensure URL has a protocol for parsing
    if (!urlStr.startsWith("http://") && !urlStr.startsWith("https://")) {
      urlStr = "https://" + urlStr;
    }
    const url = new URL(urlStr);
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}


/**
 * Public Suffix List lookup tables, built lazily on first use.
 *
 * Split into three sets because the PSL matching algorithm treats them
 * differently: an exception rule (`!city.kobe.jp`) overrides everything, a
 * wildcard rule (`*.ck`) matches any single label in that position, and an
 * ordinary rule matches literally.
 */
let exactRules: Set<string> | null = null;
let wildcardRules: Set<string> | null = null;
let exceptionRules: Set<string> | null = null;

function ensureRulesLoaded(): void {
  if (exactRules) return;
  const exact = new Set<string>();
  const wildcard = new Set<string>();
  const exception = new Set<string>();
  for (const rule of PUBLIC_SUFFIX_RULES.split("\n")) {
    if (!rule) continue;
    if (rule.startsWith("!")) exception.add(rule.slice(1));
    else if (rule.startsWith("*.")) wildcard.add(rule.slice(2));
    else exact.add(rule);
  }
  exactRules = exact;
  wildcardRules = wildcard;
  exceptionRules = exception;
}

/**
 * The public suffix of a hostname, or null when no rule matches.
 *
 * Implements the algorithm from https://publicsuffix.org/list/ over the
 * multi-label subset of the list we ship (see scripts/generate-psl.mjs for why
 * the single-label rules are redundant).
 */
function publicSuffixOf(labels: string[]): string | null {
  ensureRulesLoaded();

  // An exception rule wins outright, and the public suffix becomes the rule
  // with its leftmost label removed. Walking left to right tries the longest
  // candidate first, which is the one the spec wants.
  for (let i = 0; i < labels.length; i++) {
    if (exceptionRules!.has(labels.slice(i).join("."))) {
      return labels.slice(i + 1).join(".");
    }
  }

  // Otherwise the longest matching rule wins. Walking right to left makes each
  // candidate longer than the last, so the final match found is the longest.
  let longest: string | null = null;
  for (let i = labels.length - 1; i >= 0; i--) {
    const candidate = labels.slice(i).join(".");
    if (exactRules!.has(candidate)) {
      longest = candidate;
    } else if (i < labels.length - 1 && wildcardRules!.has(labels.slice(i + 1).join("."))) {
      longest = candidate;
    }
  }
  return longest;
}

/**
 * Get the registrable domain (eTLD+1) from a hostname, using the Public
 * Suffix List.
 *
 * This is the anti-phishing primitive: every fill decision reduces to "do
 * these two hostnames share a registrable domain?". A hand-maintained suffix
 * table gets that wrong for shared hosting — `victim.github.io` and
 * `attacker.github.io` both collapse to `github.io` unless `github.io` is
 * known to be a public suffix — and a wrong answer here means typing a
 * password into someone else's site. The list is the only ground truth for
 * that, so we ship it.
 *
 * "login.github.com"    -> "github.com"
 * "app.example.co.uk"   -> "example.co.uk"
 * "victim.github.io"    -> "victim.github.io"   (github.io is a public suffix)
 * "shop.brand.unknown"  -> "brand.unknown"      (unlisted TLD, PSL says treat as `*`)
 */
export function getRegistrableDomain(hostname: string): string {
  hostname = hostname.toLowerCase().replace(/\.$/, "");

  // IP addresses have no registrable domain — compare them whole.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return hostname;
  if (hostname.startsWith("[")) return hostname; // IPv6

  const labels = hostname.split(".");
  const suffix = publicSuffixOf(labels);

  if (suffix !== null) {
    const suffixLength = suffix === "" ? 0 : suffix.split(".").length;
    // The hostname IS a public suffix (or shorter). It has no registrable
    // domain, so return it unchanged rather than collapsing it onto a shorter
    // shared name. Failing closed here keeps two different hosts different.
    if (labels.length <= suffixLength) return hostname;
    return labels.slice(labels.length - suffixLength - 1).join(".");
  }

  // No rule matched. The PSL specifies that an unlisted TLD behaves as if the
  // rule `*` matched, which makes the registrable domain the last two labels.
  if (labels.length >= 2) return labels.slice(-2).join(".");

  return hostname;
}

/**
 * Check if two URLs share the same registrable domain.
 */
export function domainMatches(urlA: string, urlB: string): boolean {
  const domainA = extractDomain(urlA);
  const domainB = extractDomain(urlB);
  if (!domainA || !domainB) return false;
  return getRegistrableDomain(domainA) === getRegistrableDomain(domainB);
}

/**
 * Score a credential's relevance to a given tab URL.
 * Higher score = better match.
 *
 * Tier 1 (100): Exact domain match on credential's url field
 * Tier 2 (50):  Hostname substring in page title or label
 * Tier 3 (25):  Registrable domain substring match
 *
 * @param matchMode Optional per-credential URL matching mode:
 *   - "base_domain" (default): Match on registrable domain (eTLD+1)
 *   - "host": Match on exact hostname
 *   - "exact": Match on full URL (path included)
 *   - "never": Never auto-fill this credential
 */
export function scoreCredentialMatch(
  tabUrl: string,
  credential: { url?: string; label: string; pageTitle: string },
  matchMode?: "base_domain" | "host" | "exact" | "never",
): number {
  if (matchMode === "never") return 0;

  const tabDomain = extractDomain(tabUrl);
  if (!tabDomain) return 0;

  const tabRegistrable = getRegistrableDomain(tabDomain);

  // Tier 1: Direct URL field match (mode-aware)
  if (credential.url) {
    const credDomain = extractDomain(credential.url);
    if (credDomain) {
      if (matchMode === "exact") {
        // Full URL must match (ignoring trailing slash and query string)
        try {
          const tabParsed = new URL(tabUrl);
          const credParsed = new URL(credential.url.startsWith("http") ? credential.url : `https://${credential.url}`);
          if (tabParsed.origin === credParsed.origin && tabParsed.pathname.replace(/\/$/, "") === credParsed.pathname.replace(/\/$/, "")) {
            return 100;
          }
        } catch { /* fall through */ }
        return 0; // Exact mode — no fallback to domain matching
      }
      if (matchMode === "host") {
        // Exact hostname must match
        if (credDomain === tabDomain) return 100;
        return 0;
      }
      // Default: base_domain matching
      if (getRegistrableDomain(credDomain) === tabRegistrable) {
        return 100;
      }
    }
  }

  // If a strict mode was specified and Tier 1 didn't match, stop here
  if (matchMode === "host" || matchMode === "exact") return 0;

  // Tier 1b: Credential has no url field — many real vaults store logins
  // with just a label like "google - user@gmail.com" and no explicit URL.
  // If the domain-base appears as a whole token at the start of the label,
  // that's a plausible match worth SHOWING in the picker — but it is a weak,
  // spoofable heuristic (any site whose registrable base is "google" would
  // match a "google" label). It MUST NOT reach the auto-fill threshold
  // (>=100); see `isAutofillSafe`. Scored as a Tier-2-level hint only.
  const domainBase = tabRegistrable.split(".")[0].toLowerCase();
  const labelLower = credential.label.toLowerCase();
  const tokenRe = new RegExp(
    `(^|[^a-z0-9])${domainBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`,
  );
  if (!credential.url && tokenRe.test(labelLower)) {
    return 50;
  }

  // Tier 2: Label or page title contains domain as a token
  const searchText = `${credential.label} ${credential.pageTitle}`.toLowerCase();
  if (tokenRe.test(searchText)) {
    return 50;
  }

  // Tier 3: Registrable domain appears in label/title
  if (searchText.includes(tabRegistrable.toLowerCase())) {
    return 25;
  }

  return 0;
}

/**
 * Whether a saved credential's stored URL is a genuine domain MISMATCH against
 * the host the user is currently on. Compared at the registrable-domain level
 * so legitimate subdomains (`accounts.google.com` vs `google.com`) are NOT
 * flagged, but cross-site fills (`github.com` cred on `github-login.evil.com`)
 * ARE. Returns false when the credential has no usable URL — callers decide
 * how to treat "no evidence" (auto-fill blocks it; manual fill allows it).
 */
export function isDomainMismatch(savedUrl: string | undefined, currentHost: string): boolean {
  if (!savedUrl) return false;
  const saved = extractDomain(savedUrl);
  if (!saved) return false;
  const savedReg = getRegistrableDomain(saved);
  const curReg = getRegistrableDomain(currentHost.toLowerCase());
  return savedReg !== curReg;
}

/**
 * Gate for AUTOMATIC (no-click) auto-fill. Unlike scoring — which powers the
 * picker list and badge — this demands POSITIVE cryptographic-strength-ish
 * evidence that the credential belongs to this exact site before we type a
 * password into a page the user never interacted with:
 *
 *   - The credential MUST carry a stored URL (no label-token heuristics).
 *   - "exact": full origin + path must match.
 *   - "host":  hostname must match exactly.
 *   - default/"base_domain": registrable domains must match.
 *
 * Anything else returns false → no silent auto-fill. Manual fill paths do NOT
 * use this (the user explicitly chose the credential) but are still subject to
 * the blocking phishing/mismatch check.
 */
export function isAutofillSafe(
  tabUrl: string,
  credential: { url?: string },
  matchMode?: "base_domain" | "host" | "exact" | "never",
): boolean {
  if (matchMode === "never") return false;
  if (!credential.url) return false; // no stored URL → never silent-fill

  const credDomain = extractDomain(credential.url);
  const tabDomain = extractDomain(tabUrl);
  if (!credDomain || !tabDomain) return false;

  if (matchMode === "exact") {
    try {
      const tabParsed = new URL(tabUrl);
      const credParsed = new URL(
        credential.url.startsWith("http") ? credential.url : `https://${credential.url}`,
      );
      return (
        tabParsed.origin === credParsed.origin &&
        tabParsed.pathname.replace(/\/$/, "") === credParsed.pathname.replace(/\/$/, "")
      );
    } catch {
      return false;
    }
  }

  if (matchMode === "host") {
    return credDomain === tabDomain;
  }

  // default / base_domain
  return getRegistrableDomain(credDomain) === getRegistrableDomain(tabDomain);
}

/** Detect credit card brand from card number prefix. */
export function detectCardBrand(number: string): { brand: string; color: string } | null {
  const clean = number.replace(/\s/g, "");
  if (!clean) return null;
  if (/^4/.test(clean)) return { brand: "Visa", color: "#1a1f71" };
  if (/^5[1-5]/.test(clean) || /^2[2-7]/.test(clean)) return { brand: "Mastercard", color: "#eb001b" };
  if (/^3[47]/.test(clean)) return { brand: "Amex", color: "#006fcf" };
  if (/^6(?:011|5)/.test(clean)) return { brand: "Discover", color: "#ff6600" };
  if (/^35/.test(clean)) return { brand: "JCB", color: "#0e4c96" };
  if (/^3(?:0[0-5]|[68])/.test(clean)) return { brand: "Diners", color: "#004c97" };
  if (/^62/.test(clean)) return { brand: "UnionPay", color: "#de2910" };
  return null;
}
