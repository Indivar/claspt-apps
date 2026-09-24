// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

/**
 * Generated passwords that could not reach the vault yet.
 *
 * Every generated password is kept in the vault. When the desktop is closed
 * or the vault locked, the worker parks the value here, in memory-backed
 * session storage, and writes it on the next successful record or the next
 * reconnection. The outbox used to be kept by the page-side caller in the
 * same storage, which needed session storage opened to every content
 * script; the worker holds it now and content scripts never touch it.
 *
 * Session storage does not survive closing the browser. The alternative,
 * `chrome.storage.local`, would write generated passwords to disk in
 * cleartext, which is what keeping them in the vault was for. Callers are
 * told a value was parked so the user can be shown it is not saved yet.
 */
import type { ApiClient } from "./api-client";
import { recordGenerated } from "./generated-history-store";

const OUTBOX_KEY = "claspt_generated_outbox";
const MAX_OUTBOX = 50;

export interface OutboxEntry {
  password: string;
  site: string;
  generated: string;
}

async function readOutbox(): Promise<OutboxEntry[]> {
  try {
    const data = await chrome.storage.session.get(OUTBOX_KEY);
    return (data?.[OUTBOX_KEY] as OutboxEntry[] | undefined) ?? [];
  } catch {
    return [];
  }
}

async function writeOutbox(entries: OutboxEntry[]): Promise<void> {
  try {
    await chrome.storage.session.set({ [OUTBOX_KEY]: entries.slice(0, MAX_OUTBOX) });
  } catch {
    // Storage unavailable; the caller has already been told the save failed.
  }
}

/** Hold a password the vault could not take. */
export async function parkGenerated(entry: OutboxEntry): Promise<void> {
  const existing = await readOutbox();
  if (existing.some((e) => e.password === entry.password)) return;
  await writeOutbox([entry, ...existing]);
}

/** How many generated passwords are waiting to reach the vault. */
export async function parkedGeneratedCount(): Promise<number> {
  return (await readOutbox()).length;
}

/** Retry everything parked; whatever still fails stays parked. */
export async function flushGeneratedOutbox(api: ApiClient): Promise<void> {
  const parked = await readOutbox();
  if (parked.length === 0) return;
  const stillParked: OutboxEntry[] = [];
  for (const entry of parked) {
    try {
      await recordGenerated(api, {
        password: entry.password,
        site: entry.site,
        source: "browser extension",
        used: false,
        generated: entry.generated,
      });
    } catch {
      stillParked.push(entry);
    }
  }
  await writeOutbox(stillParked);
}
