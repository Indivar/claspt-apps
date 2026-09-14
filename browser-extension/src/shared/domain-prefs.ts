// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Per-domain auto-fill preferences.
 * Stores which credential to use for each domain and whether auto-fill is enabled.
 */

const STORAGE_KEY = "claspt_domain_prefs";

export interface DomainPref {
  /** The preferred credential label to auto-fill for this domain */
  preferredLabel?: string;
  /** The page path containing the preferred credential */
  preferredPagePath?: string;
  /** Whether auto-fill is enabled for this domain (default: true) */
  autoFillEnabled: boolean;
  /** Never prompt to save credentials for this domain */
  neverSave?: boolean;
  /** URL matching mode: base_domain (default), host (exact hostname), exact (full URL), never (skip) */
  matchMode?: "base_domain" | "host" | "exact" | "never";
}

export type DomainPrefs = Record<string, DomainPref>;

/** Load all domain preferences from storage. */
export async function loadDomainPrefs(): Promise<DomainPrefs> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return stored[STORAGE_KEY] || {};
}

/** Save all domain preferences to storage. */
export async function saveDomainPrefs(prefs: DomainPrefs): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: prefs });
}

/** Get preferences for a specific domain. */
export async function getDomainPref(domain: string): Promise<DomainPref | null> {
  const prefs = await loadDomainPrefs();
  return prefs[domain] || null;
}

/** Set preferences for a specific domain. */
export async function setDomainPref(domain: string, pref: DomainPref): Promise<void> {
  const prefs = await loadDomainPrefs();
  prefs[domain] = pref;
  await saveDomainPrefs(prefs);
}

/** Remove preferences for a specific domain. */
export async function removeDomainPref(domain: string): Promise<void> {
  const prefs = await loadDomainPrefs();
  delete prefs[domain];
  await saveDomainPrefs(prefs);
}

/**
 * Whether Claspt should stay out of this hostname entirely.
 *
 * A user who excludes `example.com` means the whole site, so subdomains are
 * covered too. The list is what the popup's "Excluded domains" field writes;
 * before this existed the setting was stored and displayed but never read by
 * anything, so excluding a site did nothing at all.
 */
export function isExcludedDomain(hostname: string, excludedDomains: string[]): boolean {
  const host = hostname.toLowerCase();
  return excludedDomains.some((entry) => {
    const excluded = entry.trim().toLowerCase();
    if (!excluded) return false;
    return host === excluded || host.endsWith(`.${excluded}`);
  });
}
