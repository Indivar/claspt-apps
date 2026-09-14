// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Desktop side of "every generated password is kept".
 *
 * Writes the same vault layout the browser extension writes — see
 * `shared/src/generated-history.ts` for the shape and the reasoning — so a
 * password generated on either one shows up in the same place, tagged with
 * where it came from.
 *
 * The extension goes through the local HTTP API, which has a block-level patch
 * endpoint. The desktop has no such command exposed to the frontend, so it does
 * read / append / write on the page: `read_page` hands back decrypted markdown,
 * and `update_page` re-encrypts every secret block on the way in. The block is
 * therefore built as text here, with the label escaped exactly as the Rust
 * escapes it.
 */

import * as cmd from "@/lib/commands";
import {
  HISTORY_FOLDER,
  extractSecretBlocks,
  removeBlock,
  setFieldInBlock,
  monthPageIntro,
  monthPageTitle,
  parseHistoryBlock,
  renderHistoryBlock,
  sortNewestFirst,
  unusedEntriesOlderThan,
  type StoredGeneratedEntry,
} from "@claspt/shared";

/**
 * Values recorded during this session, so Copy and Insert can mark the entry
 * they already created rather than writing a second copy of the same password.
 */
const recordedThisSession = new Map<string, { pagePath: string; label: string }>();

/** Find this month's page, creating it if it does not exist yet. */
async function monthPagePath(when: Date): Promise<string> {
  const title = monthPageTitle(when);
  const pages = await cmd.listPages();
  const match = pages.find(
    (p) => p.meta.folder === HISTORY_FOLDER && p.meta.title === title,
  );
  if (match) return match.path;

  const page = await cmd.createPage(title, HISTORY_FOLDER, monthPageIntro(when));
  return page.path;
}

/**
 * Keep a generated password.
 *
 * Silently does nothing if the value was already recorded in this session —
 * the generator calls this on a debounce, and a value that has not changed
 * should not produce a second entry.
 */
export async function recordGeneratedValue(value: string): Promise<void> {
  if (!value || recordedThisSession.has(value)) return;

  const when = new Date();
  const entry = {
    password: value,
    site: "",
    source: "desktop app" as const,
    used: false,
    generated: when.toISOString(),
  };

  const path = await monthPagePath(when);
  const page = await cmd.readPage(path);
  const block = renderHistoryBlock(entry, when);
  const body = page.content.trimEnd();
  await cmd.updatePage(path, `${body}\n\n${block}\n`);

  // Re-read the label out of what we just rendered so the marker matches the
  // block exactly, escaping included.
  const label = extractSecretBlocks(block)[0]?.label ?? "";
  recordedThisSession.set(value, { pagePath: path, label });
}

/** Mark a kept password as taken up, so the clear-unused action leaves it. */
export async function markGeneratedValueUsed(value: string): Promise<void> {
  const at = recordedThisSession.get(value);
  if (!at) {
    // Not recorded yet (the debounce had not fired) — record it now, as used.
    await recordGeneratedValue(value);
  }
  const target = recordedThisSession.get(value);
  if (!target) return;

  const page = await cmd.readPage(target.pagePath);
  const updated = setFieldInBlock(page.content, target.label, "used", "yes");
  if (updated !== page.content) await cmd.updatePage(target.pagePath, updated);
}

/** Every generated password in the vault, newest first. */
export async function listGeneratedHistory(): Promise<StoredGeneratedEntry[]> {
  const pages = await cmd.listPages();
  const historyPages = pages.filter((p) => p.meta.folder === HISTORY_FOLDER);

  const entries: StoredGeneratedEntry[] = [];
  for (const summary of historyPages) {
    try {
      const page = await cmd.readPage(summary.path);
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
 * `days`. Returns how many went.
 *
 * Anything marked used is left alone at any age — those may still be in
 * service somewhere.
 */
export async function clearUnusedGenerated(days: number): Promise<number> {
  const entries = await listGeneratedHistory();
  const doomed = unusedEntriesOlderThan(entries, days);
  if (doomed.length === 0) return 0;

  const byPage = new Map<string, StoredGeneratedEntry[]>();
  for (const entry of doomed) {
    const list = byPage.get(entry.pagePath) ?? [];
    list.push(entry);
    byPage.set(entry.pagePath, list);
  }

  let removed = 0;
  for (const [path, victims] of byPage) {
    try {
      const page = await cmd.readPage(path);
      let content = page.content;
      for (const victim of victims) {
        const next = removeBlock(content, victim.label);
        if (next !== content) {
          content = next;
          removed++;
        }
      }
      await cmd.updatePage(path, content);
      for (const victim of victims) recordedThisSession.delete(victim.password);
    } catch {
      // Leave the rest of the sweep running.
    }
  }
  return removed;
}
