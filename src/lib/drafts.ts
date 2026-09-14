// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Crash-recovery drafts.
 *
 * The editor mirrors the buffer into `localStorage` as you type so an unclean
 * shutdown does not lose unsaved edits. That storage is unencrypted and outlives
 * the process, so what may go into it, and how long it stays, are security
 * decisions rather than convenience ones — which is why they live here rather
 * than inline in the editor component.
 */

/** Key prefix for per-page drafts. Everything under it is disposable. */
export const DRAFT_PREFIX = "draft:";

/** Storage key holding the draft for one page. */
export function draftKeyFor(pageId: string): string {
  return `${DRAFT_PREFIX}${pageId}`;
}

/**
 * Whether a page's buffer may be mirrored into a draft at all.
 *
 * A full-body-encrypted page has no plaintext-safe portion: the whole decrypted
 * body is the protected material, and the secret-block redaction only removes
 * `:::secret` fences. Mirroring it would put the entire page into unencrypted
 * browser storage. Those pages therefore get no draft — losing crash recovery
 * for them is the smaller cost.
 */
export function canPersistDraft(page: { meta: { encrypted: boolean } }): boolean {
  return !page.meta.encrypted;
}

/**
 * Drop every draft.
 *
 * Called whenever the vault locks. A draft is derived from decrypted content,
 * so leaving it readable behind the lock screen would let anyone at the machine
 * recover page text the lock is supposed to have taken away. Drafts only ever
 * cover the seconds between a keystroke and the auto-save, so discarding them at
 * lock costs nothing the user can notice.
 *
 * Storage access can throw outright (Safari private mode, blocked site data),
 * so failure here must never propagate into the lock path — a vault that
 * refuses to lock is worse than a draft that outlives it.
 */
export function clearAllDrafts(): void {
  try {
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key?.startsWith(DRAFT_PREFIX)) stale.push(key);
    }
    for (const key of stale) localStorage.removeItem(key);
  } catch {
    // Storage unavailable — nothing to clear, and nothing worth failing over.
  }
}
