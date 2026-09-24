// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

import type { Message } from "./types";

/**
 * Client side of "every generated password is kept".
 *
 * Both generators, the in-page picker and the popup, call
 * {@link recordGeneratedPassword} for every value they produce, and
 * {@link markGeneratedPasswordUsed} when the user copies or fills one.
 *
 * A password that cannot reach the vault (desktop closed, vault locked) is
 * parked by the background worker and flushed when the vault is reachable
 * again; see `background/generated-outbox.ts`. Callers are told when a save
 * did not happen, so the user can be shown rather than quietly losing it.
 */

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

/**
 * Keep a generated password.
 *
 * Returns where it was stored, or null when it could not be stored yet, in
 * which case the worker holds it and the caller should tell the user it is
 * not saved yet.
 */
export async function recordGeneratedPassword(
  password: string,
  site: string,
): Promise<RecordedAt | null> {
  if (!password) return null;
  const res = await send({ type: "RECORD_GENERATED_PASSWORD", password, site });
  if (res?.type === "RECORD_GENERATED_PASSWORD_RESULT" && res.success && res.pagePath && res.label) {
    return { pagePath: res.pagePath, label: res.label };
  }
  return null;
}

/** Mark a kept password as taken up, so the clear-unused sweep leaves it. */
export async function markGeneratedPasswordUsed(at: RecordedAt): Promise<void> {
  await send({ type: "MARK_GENERATED_USED", pagePath: at.pagePath, label: at.label });
}
