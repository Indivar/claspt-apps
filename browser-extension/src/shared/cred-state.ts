// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Per-credential client-side state: pin + last-used timestamp.
 * Stored extension-side in chrome.storage.local — no vault format change,
 * no desktop coordination required.
 *
 * Key shape: `${pagePath}::${label}` so the same page can host multiple
 * named credentials independently.
 *
 * KNOWN EXPOSURE, and why it is shaped this way.
 *
 * Those keys are cleartext on disk, so the browser profile holds a readable
 * index of which accounts the user has — the vault filename carries the title
 * slug, and the label is the credential's name. Two fixes were considered and
 * rejected, so the reasoning is recorded here rather than re-litigated:
 *
 *  - Hashing the keys. The preimage space is guessable. An attacker holding
 *    the profile can test "credentials/<date>-chase-bank.md::Chase Login" as
 *    fast as they can hash it, so an unsalted digest buys obfuscation, not
 *    secrecy. Salting it properly needs key material derived from the vault,
 *    which the extension does not have and cannot be given without a
 *    desktop-side change.
 *  - Keying the store by hash and looking up asynchronously. Every call site
 *    is on a render path, so a not-yet-warm lookup makes pins flicker. That is
 *    real breakage traded for the weak protection above.
 *
 * What IS done: `lastUsed` — the more telling half, since it records when each
 * account was used — is wiped on vault lock, alongside the recently-used list
 * the background worker already clears. Pins survive, because losing them on
 * every lock is a feature regression the user would notice. Removing the
 * cleartext index for good needs a vault-derived salt from the desktop.
 */

export interface CredState {
  pinned: Record<string, true>;
  lastUsed: Record<string, number>;
}

const KEY = "claspt_cred_state";

const DEFAULT_STATE: CredState = { pinned: {}, lastUsed: {} };

export function credKey(pagePath: string, label: string): string {
  return `${pagePath}::${label}`;
}

let cached: CredState | null = null;
const listeners = new Set<(s: CredState) => void>();

/**
 * One-time migration of the legacy pre-1.8.0 popup pin store
 * (`claspt_pinned: string[]` keyed by pagePath only) into the unified
 * `claspt_cred_state` shape. We don't have label info for legacy entries —
 * pin them under `${pagePath}::*` and let the user re-pin precisely later.
 */
const LEGACY_PIN_KEY = "claspt_pinned";
let migrationRan = false;
async function migrateLegacyPinsOnce(): Promise<void> {
  if (migrationRan) return;
  migrationRan = true;
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([KEY, LEGACY_PIN_KEY], (data) => {
        const legacy = data?.[LEGACY_PIN_KEY] as string[] | undefined;
        if (!Array.isArray(legacy) || legacy.length === 0) { resolve(); return; }
        const current = (data?.[KEY] as Partial<CredState> | undefined) ?? {};
        const pinned = { ...(current.pinned ?? {}) };
        for (const pagePath of legacy) pinned[`${pagePath}::*`] = true;
        chrome.storage.local.set(
          { [KEY]: { ...current, pinned, lastUsed: current.lastUsed ?? {} } },
          () => chrome.storage.local.remove(LEGACY_PIN_KEY, () => resolve())
        );
      });
    } catch { resolve(); }
  });
}

async function readRaw(): Promise<CredState> {
  await migrateLegacyPinsOnce();
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(KEY, (data) => {
        const stored = data?.[KEY] as Partial<CredState> | undefined;
        resolve({
          pinned: { ...DEFAULT_STATE.pinned, ...(stored?.pinned ?? {}) },
          lastUsed: { ...DEFAULT_STATE.lastUsed, ...(stored?.lastUsed ?? {}) },
        });
      });
    } catch {
      resolve({ ...DEFAULT_STATE });
    }
  });
}

export async function loadCredState(): Promise<CredState> {
  if (cached) return cached;
  cached = await readRaw();
  return cached;
}

async function writeRaw(state: CredState): Promise<void> {
  cached = state;
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set({ [KEY]: state }, () => {
        listeners.forEach((fn) => fn(state));
        resolve();
      });
    } catch {
      resolve();
    }
  });
}

export async function togglePin(key: string): Promise<CredState> {
  const state = await loadCredState();
  const next: CredState = {
    pinned: { ...state.pinned },
    lastUsed: { ...state.lastUsed },
  };
  if (next.pinned[key]) delete next.pinned[key];
  else next.pinned[key] = true;
  await writeRaw(next);
  return next;
}

export async function markUsed(key: string): Promise<void> {
  const state = await loadCredState();
  await writeRaw({
    pinned: state.pinned,
    lastUsed: { ...state.lastUsed, [key]: Date.now() },
  });
}

export function onCredStateChange(fn: (s: CredState) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Drop the last-used timestamps, keeping pins. Called when the vault locks.
 *
 * See the exposure note at the top of this file: a locked extension should not
 * still be holding a record of when each account was used.
 */
export async function clearLastUsed(): Promise<void> {
  const state = await loadCredState();
  await writeRaw({ pinned: state.pinned, lastUsed: {} });
}

// Cross-tab updates: if another popup/content script writes, refresh.
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[KEY]) return;
    cached = null;
    void loadCredState().then((s) => listeners.forEach((fn) => fn(s)));
  });
} catch {
  /* no-op outside extension context */
}

/**
 * Is this credential pinned? Direct match on `${pagePath}::${label}`, with
 * fallback to a `${pagePath}::*` wildcard from the legacy pre-1.8.0 popup
 * pin store (which only knew about pages, not individual credentials).
 */
export function isPinned(state: CredState, pagePath: string, label: string): boolean {
  return !!state.pinned[credKey(pagePath, label)] || !!state.pinned[`${pagePath}::*`];
}

/** Sort credentials: pinned first, then by lastUsed desc, stable. */
export function sortByPinAndRecency<T extends { pagePath: string; label: string }>(
  items: T[],
  state: CredState
): T[] {
  const annotated = items.map((item, idx) => {
    const k = credKey(item.pagePath, item.label);
    return {
      item,
      pinned: isPinned(state, item.pagePath, item.label),
      lastUsed: state.lastUsed[k] ?? 0,
      idx,
    };
  });
  annotated.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.lastUsed !== b.lastUsed) return b.lastUsed - a.lastUsed;
    return a.idx - b.idx;
  });
  return annotated.map((a) => a.item);
}
