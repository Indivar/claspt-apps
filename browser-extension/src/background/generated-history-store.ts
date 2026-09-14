// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import type { ApiClient } from "./api-client";
import { extractSecretBlocks } from "@claspt/shared/secret-parser";
import {
  HISTORY_FOLDER,
  HISTORY_TAG,
  historyBlockFields,
  historyBlockLabel,
  monthPageIntro,
  monthPageTitle,
  parseHistoryBlock,
  sortNewestFirst,
  unusedEntriesOlderThan,
  type GeneratedEntry,
  type StoredGeneratedEntry,
} from "@claspt/shared/generated-history";

/**
 * Vault-backed store for generated passwords.
 *
 * Lives in the background worker rather than being reachable as a page-path
 * write from a content script: recording a password has to name a page in a
 * folder the calling site can't see, and `contentScriptMayPatch` deliberately
 * refuses exactly that. The inline generator asks the worker to record; the
 * worker owns the vault work.
 *
 * See `shared/generated-history.ts` for the on-disk layout and why it is shaped
 * that way.
 */

/** month page title -> page path, so a generation is one request in the common case. */
const pathByTitle = new Map<string, string>();

/** Forget cached paths — call when a write fails, or the vault may have changed. */
export function resetHistoryPathCache(): void {
  pathByTitle.clear();
}

/** Find the page for this month, creating it if it does not exist yet. */
async function monthPagePath(api: ApiClient, when: Date): Promise<string> {
  const title = monthPageTitle(when);

  const cached = pathByTitle.get(title);
  if (cached) return cached;

  let existing: Awaited<ReturnType<ApiClient["listPages"]>> = [];
  try {
    existing = await api.listPages(HISTORY_FOLDER);
  } catch {
    // Folder does not exist yet — creating the page creates it.
  }

  const match = existing.find((p) => p.meta?.title === title);
  if (match) {
    pathByTitle.set(title, match.path);
    return match.path;
  }

  const page = await api.createPage({
    title,
    content: monthPageIntro(when),
    folder: HISTORY_FOLDER,
    tags: [HISTORY_TAG],
  });
  pathByTitle.set(title, page.path);
  return page.path;
}

/**
 * Write one generated password into the vault.
 *
 * Returns where it landed so the caller can mark it used later without
 * searching for it again.
 */
export async function recordGenerated(
  api: ApiClient,
  entry: GeneratedEntry,
): Promise<{ pagePath: string; label: string }> {
  const when = new Date(entry.generated);
  const label = historyBlockLabel(entry.site, when);

  try {
    const pagePath = await monthPagePath(api, when);
    await api.patchSecretBlock(pagePath, {
      label,
      fields: historyBlockFields(entry),
      upsert: true,
    });
    return { pagePath, label };
  } catch (err) {
    // A stale cached path (page renamed or deleted in the desktop) would fail
    // every subsequent write, so drop the cache before giving up.
    resetHistoryPathCache();
    throw err;
  }
}

/** Mark an entry as taken up, so the clear-unused action leaves it alone. */
export async function markGeneratedUsed(
  api: ApiClient,
  pagePath: string,
  label: string,
): Promise<void> {
  await api.patchSecretBlock(pagePath, { label, fields: { used: "yes" } });
}

/** Every generated password in the vault, newest first. */
export async function listGenerated(api: ApiClient): Promise<StoredGeneratedEntry[]> {
  let pages: Awaited<ReturnType<ApiClient["listPages"]>>;
  try {
    pages = await api.listPages(HISTORY_FOLDER);
  } catch {
    return []; // No history folder yet.
  }

  const entries: StoredGeneratedEntry[] = [];
  for (const summary of pages) {
    try {
      const page = await api.getPage(summary.path);
      for (const block of extractSecretBlocks(page.content)) {
        const entry = parseHistoryBlock(summary.path, block.label, block.fields);
        if (entry) entries.push(entry);
      }
    } catch {
      // Skip a page that failed to load rather than losing the whole list.
    }
  }
  return sortNewestFirst(entries);
}

/**
 * Remove generated passwords that were never taken up and are older than
 * `days`.
 *
 * Anything marked used is left alone whatever its age — those are passwords
 * that may still be in service somewhere. The age floor means a password
 * generated a moment ago and not yet used is never swept away mid-task.
 */
export async function clearUnusedGenerated(
  api: ApiClient,
  days: number,
): Promise<number> {
  const entries = await listGenerated(api);
  const doomed = unusedEntriesOlderThan(entries, days);

  let removed = 0;
  for (const entry of doomed) {
    try {
      await api.deleteSecretBlock(entry.pagePath, {
        label: entry.label,
        delete_page_if_empty: true,
      });
      removed++;
    } catch {
      // Leave the rest of the sweep running; report what actually went.
    }
  }
  if (removed > 0) resetHistoryPathCache();
  return removed;
}
