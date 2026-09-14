// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import type { Message } from "./types";

/**
 * Client side of "every generated password is kept".
 *
 * Both generators — the in-page picker and the popup — call
 * {@link recordGeneratedPassword} for every value they produce, and
 * {@link markGeneratedPasswordUsed} when the user copies or fills one.
 *
 * A password that cannot reach the vault (desktop closed, vault locked) is
 * parked in `chrome.storage.session` and flushed on the next successful
 * record. Session storage is memory-backed, so an outbox entry does not
 * survive closing the browser — the alternative, `chrome.storage.local`, would
 * write generated passwords to disk in cleartext, which is what moving this
 * into the vault was for. Callers are told when a save did not happen, so the
 * user can be shown rather than quietly losing it.
 */

const OUTBOX_KEY = "claspt_generated_outbox";
const MAX_OUTBOX = 50;

interface OutboxEntry {
  password: string;
  site: string;
  generated: string;
}

/** Where a recorded password landed, so it can be marked used later. */
export interface RecordedAt {
  pagePath: string;
  label: string;
}

function send(message: Message): Promise<Message | null> {
  return new Promise((resolve) => {
    try {
      if (!chrome.runtime?.id) return resolve(null);
      chrome.runtime.sendMessage(message, (response: Message) => {
        if (chrome.runtime.lastError) return resolve(null);
        resolve(response ?? null);
      });
    } catch {
      resolve(null);
    }
  });
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
    /* storage unavailable — nothing further we can do */
  }
}

async function park(entry: OutboxEntry): Promise<void> {
  const existing = await readOutbox();
  if (existing.some((e) => e.password === entry.password)) return;
  await writeOutbox([entry, ...existing]);
}

/** Retry everything parked while the vault was out of reach. */
async function flushOutbox(): Promise<void> {
  const parked = await readOutbox();
  if (parked.length === 0) return;

  const stillParked: OutboxEntry[] = [];
  for (const entry of parked) {
    const res = await send({
      type: "RECORD_GENERATED_PASSWORD",
      password: entry.password,
      site: entry.site,
    });
    const ok = res?.type === "RECORD_GENERATED_PASSWORD_RESULT" && res.success;
    if (!ok) stillParked.push(entry);
  }
  await writeOutbox(stillParked);
}

/**
 * Keep a generated password.
 *
 * Returns where it was stored, or null when it could not be stored — in which
 * case it has been parked and the caller should tell the user it is not saved
 * yet.
 */
export async function recordGeneratedPassword(
  password: string,
  site: string,
): Promise<RecordedAt | null> {
  if (!password) return null;

  const res = await send({ type: "RECORD_GENERATED_PASSWORD", password, site });
  if (res?.type === "RECORD_GENERATED_PASSWORD_RESULT" && res.success && res.pagePath && res.label) {
    // A successful write means the vault is reachable, so this is the moment to
    // retry anything parked earlier.
    void flushOutbox();
    return { pagePath: res.pagePath, label: res.label };
  }

  await park({ password, site, generated: new Date().toISOString() });
  return null;
}

/** Mark a kept password as taken up, so the clear-unused sweep leaves it. */
export async function markGeneratedPasswordUsed(at: RecordedAt): Promise<void> {
  await send({ type: "MARK_GENERATED_USED", pagePath: at.pagePath, label: at.label });
}

/** How many generated passwords are waiting to reach the vault. */
export async function pendingGeneratedCount(): Promise<number> {
  return (await readOutbox()).length;
}
