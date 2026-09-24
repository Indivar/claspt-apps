// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Which identity was last used on which site.
 *
 * Someone with a home address and a work address picks between them on every
 * checkout, and the right answer is nearly always the one they picked last
 * time on that site. Remembering it turns a decision into a confirmation.
 *
 * Only the page path is stored — `identities/home.md` — never a name, an
 * address or any other value. Those stay in the vault, encrypted, and are
 * fetched on demand like every other secret. The store is
 * `chrome.storage.local`, so it does not leave this browser profile and does
 * not sync.
 *
 * Keyed by hostname rather than registrable domain, deliberately: `work` on a
 * company's intranet and `home` on its public shop are a reasonable thing to
 * want, and being wrong here costs a dropdown rather than a leak.
 */

const KEY = "claspt:identity-for-site";

type SiteMap = Record<string, string>;

/** Cap the map so a long browsing history cannot grow it without limit. */
const MAX_SITES = 200;

async function read(): Promise<SiteMap> {
  try {
    const stored = await chrome.storage.local.get(KEY);
    const map = stored?.[KEY];
    return map && typeof map === "object" ? (map as SiteMap) : {};
  } catch {
    // Storage can be unavailable (private mode, cleared site data). A missing
    // preference is a dropdown in a different order, not an error worth
    // surfacing.
    return {};
  }
}

/** The identity last used on `host`, or null if there is no record. */
export async function identityForSite(host: string): Promise<string | null> {
  const map = await read();
  return map[host] ?? null;
}

/** Record that `pagePath` was used on `host`. */
export async function rememberIdentityForSite(
  host: string,
  pagePath: string,
): Promise<void> {
  if (!host || !pagePath) return;
  try {
    const map = await read();
    // Re-inserting moves the key to the end, so the oldest entries are the
    // ones trimmed when the cap is reached.
    delete map[host];
    map[host] = pagePath;

    const hosts = Object.keys(map);
    for (const stale of hosts.slice(0, Math.max(0, hosts.length - MAX_SITES))) {
      delete map[stale];
    }
    await chrome.storage.local.set({ [KEY]: map });
  } catch {
    // Same reasoning as read(): losing a preference is not worth an error.
  }
}

/** Drop every remembered choice. Used when the extension is unpaired. */
export async function clearIdentityPrefs(): Promise<void> {
  try {
    await chrome.storage.local.remove(KEY);
  } catch {
    // Nothing to do; the store is already unreachable.
  }
}
